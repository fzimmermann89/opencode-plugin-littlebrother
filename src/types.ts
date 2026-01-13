export interface SupervisorDecision {
  status: 'OK' | 'ABORT' | 'ALLOW' | 'BLOCK' | 'SAFE' | 'REDACT';
  reason: string;
  replacement?: string;
}

export type SupervisorQueryType = 'watchdog' | 'gatekeeper' | 'sanitizer';

export interface ToolExecuteInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface ToolExecuteBeforeOutput {
  args: Record<string, unknown>;
  message?: string;
}

export interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: unknown;
}

export interface SessionState {
  userGoal?: string;
  tokenBuffer: string[];
  lastCheckTokenCount: number;
  aborting: boolean;
  lastSupervisorFailureToastAt?: number;
}

export interface MessagePart {
  id: string;
  type: 'text' | 'tool-invocation' | 'tool-result' | string;
  sessionID: string;
  messageID: string;
  text?: string;
  tool?: string;
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error';
  };
}

export interface EventPayload {
  type: string;
  properties?: {
    part?: MessagePart;
    delta?: string;
    info?: {
      id?: string;
      sessionID?: string;
      parentID?: string;
    };
    [key: string]: unknown;
  };
}
