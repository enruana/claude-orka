/**
 * API expuesta al renderer process
 */
declare const orkaAPI: {
    initialize: () => Promise<any>;
    createSession: (name?: string, openTerminal?: boolean) => Promise<any>;
    listSessions: (filters?: any) => Promise<any>;
    getSession: (sessionId: string) => Promise<any>;
    resumeSession: (sessionId: string, openTerminal?: boolean) => Promise<any>;
    closeSession: (sessionId: string, saveContext?: boolean) => Promise<any>;
    deleteSession: (sessionId: string) => Promise<any>;
    createFork: (sessionId: string, name?: string, vertical?: boolean) => Promise<any>;
    closeFork: (sessionId: string, forkId: string, saveContext?: boolean) => Promise<any>;
    resumeFork: (sessionId: string, forkId: string) => Promise<any>;
    send: (sessionId: string, command: string, target?: string) => Promise<any>;
    export: (sessionId: string, forkId: string, customName?: string) => Promise<any>;
    merge: (sessionId: string, forkId: string) => Promise<any>;
    mergeAndClose: (sessionId: string, forkId: string) => Promise<any>;
};
export type OrkaAPI = typeof orkaAPI;
export {};
//# sourceMappingURL=preload.d.ts.map