import { GameRecordResult } from '@common/types/game.type';
import { GameService } from '@modules/game/game.service';
import { PlayerService } from '@modules/player/player.service';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { GameSession } from './lib/game.lib';
import { PlayerStatus } from '@common/types/player.type';
import { RequestDuelDto } from './dto/requestDuel.dto';
import { AnswerDuelDto } from './dto/answerDuel.dto';
import {
  GameInvitation,
  PlayerSocket,
  PutTokenOutputEvent,
} from '@common/types/game.type';
import { PutTokenToBoardDto } from './dto/putTokenToBoard.dot';

@WebSocketGateway(8080, { cors: { origin: "*" } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  public static players: PlayerSocket[] = [];
  public static games: GameSession[] = [];
  public static invitations: GameInvitation[] = [];

  constructor(
    private readonly gameService: GameService,
    private readonly playerService: PlayerService,
  ) {}

  @SubscribeMessage('send-game-invitation')
  requestDuel(
    @ConnectedSocket() client: PlayerSocket,
    @MessageBody() data: RequestDuelDto,
  ) {
    const requesterPlayerSocket = this.findPlayerBySocket(client)
    const targetPlayerSocket = this.findPlayerById(data.playerId);

    Logger.debug(targetPlayerSocket, 'GameGateway');

    if (!targetPlayerSocket) {
      Logger.debug(
        `Game invitation failed - Player ${data.playerId} not online or not found`,
        'GameGateway',
      );
      return client.emit(
        'game-invitation-failed',
        'Player not found or not online',
      );
    }

    if (targetPlayerSocket.data.gameId) {
      Logger.debug(
        `Game invitation failed - Player ${data.playerId} already in game`,
        'GameGateway',
      );
      return client.emit('game-invitation-failed', 'Player is already in a game');
    }

    const gameInvitation = {
      _id: randomUUID(),
      requester: client.data,
      responder: targetPlayerSocket.data,
    } as GameInvitation;

    GameGateway.invitations.push(gameInvitation);
    targetPlayerSocket.emit('game-invitation', gameInvitation);
  }

  @SubscribeMessage('answer-game-invitation')
  async answerDuelRequest(
    @ConnectedSocket() client: PlayerSocket,
    @MessageBody() data: AnswerDuelDto,
  ) {
    const invitation = this.findInvitationById(data.invitationId);
    const requester = this.findPlayerById(invitation?.requester?._id);
    const requestee = this.findPlayerById(invitation?.responder?._id);

    if (!invitation) {
      Logger.debug(
        `Answer duel request failed (Invitation ${data.invitationId} | player ${client.data._id}) - Invitation not found`,
        'GameGateway',
      );
      return client.emit(
        'answer-game-invitation-failed',
        'Invitation not found',
      );
    }

    if (!data.acceptDuel) {
      return requester.emit('answer-game-invitation-declined', invitation);
    }

    const gameSession = new GameSession(requestee, requester);
    await this.addPlayerToGame(requestee, gameSession, 1);
    await this.addPlayerToGame(requester, gameSession, 2);
    GameGateway.games.push(gameSession);
    this.removeInvitationFromStore(invitation);
    this.server
      .to(gameSession._id)
      .emit('game-started', gameSession.getGameState());
  }

  @SubscribeMessage('put-token-to-board')
  async putTokenToBoard(client: PlayerSocket, data: PutTokenToBoardDto) {
    const player = this.findPlayerBySocket(client);
    const game = this.findGameById(player.data.gameId);

    if (!game) {
      Logger.debug(
        `Put token to board failed (Player ${player.data._id}) - Game not found`,
        'GameGateway',
      );
      return client.emit('put-token-to-board-failed', 'Game not found');
    }

    if (game.getActivePlayer() != player.data.playerNumber) {
      Logger.debug(
        `Put token to board failed (Player ${player.data._id}) - Not your turn to play`,
        'GameGateway',
      );
      return client.emit('put-token-to-board-failed', 'Not your turn to play');
    }

    const { event, gameState } = game.putTokenToBoard(data.cellId);
    Logger.debug(JSON.stringify({ event, gameState }, null, 2), 'GameGateway');
    if (event === PutTokenOutputEvent.CellNotAvailable) {
      Logger.debug(
        `Put token to board failed (Player ${player.data._id}) - Cell not available`,
        'GameGateway',
      );
      return client.emit('put-token-to-board-failed', 'Cell not available');
    }

    if (
      [PutTokenOutputEvent.Draw, PutTokenOutputEvent.Win].includes(
        event as PutTokenOutputEvent,
      )
    ) {
      this.server.to(game._id).emit('game-ended', gameState);
      await this.gameService.saveGameRecord(
        game.getPlayerIds(),
        event as GameRecordResult,
        gameState.winner,
      );
      this.removeGameFromStore(game);
    }

    this.server.to(game._id).emit('update-game-state', gameState);
  }

  @SubscribeMessage('return-to-matchmaking')
  async returnToMatchmaking(client: PlayerSocket) {
    const player = this.findPlayerBySocket(client);
    player.data = { ...player.data, gameId: null, playerNumber: null };

    GameGateway.players[
      GameGateway.players.findIndex((p) => p.id == player.id)
    ] = player;

    await this.playerService.setPlayerStatus(
      player.data._id,
      PlayerStatus.ONLINE,
    );

    player.broadcast.emit('player-online', player.data);
  }

  async handleConnection(@ConnectedSocket() client: Socket) {
    const { playerId } = client.handshake.query;
    Logger.log(`Player ${playerId} connected`, 'GameGateway');
    Logger.debug(JSON.stringify(client.handshake.query), 'GameGateway');

    const player = await this.playerService.findOne(playerId as string);
    Logger.debug(JSON.stringify(player), 'GameGateway');
    player.status = PlayerStatus.ONLINE;
    await player.save();

    client.data = { _id: player._id, username: player.username };
    GameGateway.players.push(client as PlayerSocket);

    Logger.debug(`Player ${player.username} is ONLINE`);
    client.emit('load-lobby', GameGateway.players.map(player => player.data))
    client.broadcast.emit('player-online', client.data);
  }

  async handleDisconnect(@ConnectedSocket() client: Socket) {
    const playerSocket = this.findPlayerBySocket(client);
    this.removePlayerFromStore(playerSocket);

    await this.playerService.setPlayerStatus(
      playerSocket.data._id,
      PlayerStatus.OFFLINE,
    );

    Logger.debug(
      `Player ${playerSocket.data.username} is OFFLINE`,
      'GameGateway',
    );
    playerSocket.broadcast.emit('player-offline', playerSocket.data);
  }

  private findPlayerById(id: string) {
    return GameGateway.players.find((player) => player.data._id == id);
  }

  private findPlayerBySocket(socket: Socket) {
    return GameGateway.players.find((player) => player.id == socket.id);
  }

  private findGameById(id: string) {
    return GameGateway.games.find((game) => game._id == id);
  }

  private findInvitationById(id: string) {
    console.log({
      invitationIds: GameGateway.invitations.map((invitation) => invitation._id),
      invitationId: id,
    })
    return GameGateway.invitations.find((invitation) => invitation._id == id);
  }

  private async addPlayerToGame(
    player: PlayerSocket,
    game: GameSession,
    playerNumber,
  ) {
    player.data.gameId = game._id;
    player.data.playerNumber = playerNumber;

    GameGateway.players[
      GameGateway.players.findIndex((socket) => socket.id == player.id)
    ] = player;

    player.join(game._id);

    player.broadcast.emit('player-joined-game', player.data);
    return this.playerService.setPlayerStatus(
      player.data._id,
      PlayerStatus.IN_GAME,
    );
  }

  private removeGameFromStore(game: GameSession) {
    GameGateway.games.splice(
      GameGateway.games.findIndex((g) => g._id == game._id),
      1,
    );
  }

  private removePlayerFromStore(user: PlayerSocket) {
    GameGateway.players.splice(
      GameGateway.players.findIndex((socket) => socket.id == user.id),
      1,
    );
  }

  private removeInvitationFromStore(invitation: GameInvitation) {
    GameGateway.invitations.splice(
      GameGateway.invitations.findIndex((inv) => inv._id == invitation._id),
      1,
    );
  }
}
