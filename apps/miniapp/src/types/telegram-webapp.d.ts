export {};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        initData: string;
        initDataUnsafe?: { user?: unknown };
        platform?: string;
        version?: string;
      };
    };
  }
}
