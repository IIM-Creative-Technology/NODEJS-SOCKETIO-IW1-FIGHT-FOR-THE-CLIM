<template>
    <n-config-provider :theme="appStore.theme" :theme-overrides="appStore.themeOverrides">
        <n-dialog-provider>
            <n-message-provider>
                <n-notification-provider>
                    <n-loading-bar-provider>
                        <slot />
                    </n-loading-bar-provider>
                </n-notification-provider>
            </n-message-provider>
        </n-dialog-provider>
    </n-config-provider>
</template>

<script setup lang="ts">
    import { NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider, NLoadingBarProvider } from "naive-ui";
    import { useAppStore } from "~/stores/app.store";

    const appStore = useAppStore();
</script>
