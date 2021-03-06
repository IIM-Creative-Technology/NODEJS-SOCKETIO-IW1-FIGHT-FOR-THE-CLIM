import { useReactifiedApi } from "./useReactifiedApi";
import { VNodeChild } from "vue";

interface DialogOptions {
    type: "create" | "success" | "error" | "warning" | "info";
    title: string | (() => VNodeChild);
    content?: string | (() => VNodeChild);
    positiveText?: string;
    negativeText?: string;
    closable?: boolean;
}

export const useConfirmDialog = ({ type = "create", title, content, positiveText = "Yes", negativeText = "No" }: DialogOptions): Promise<boolean> =>
    new Promise((resolve) => {
        const { dialogApi } = useReactifiedApi();
        dialogApi?.[type]({
            title,
            content,
            positiveText,
            negativeText,
            onPositiveClick: () => resolve(true),
            onNegativeClick: () => resolve(false),
            onClose: () => resolve(false),
            onMaskClick: () => resolve(false),
        });
    });
