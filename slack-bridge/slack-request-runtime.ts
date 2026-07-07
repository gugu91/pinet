import { createAbortableOperationTracker } from "./helpers.js";
import { callSlackApi, type SlackResult } from "./slack-api.js";

export type SlackRequestBody = NonNullable<Parameters<typeof callSlackApi>[2]>;

export type SlackRequestCall = (
  method: string,
  token: string,
  body?: SlackRequestBody,
) => Promise<SlackResult>;

export interface SlackRequestRuntime {
  slack: SlackRequestCall;
  reset: () => void;
  abortAndWait: () => Promise<void>;
}

export function createSlackRequestRuntime(): SlackRequestRuntime {
  let slackRequests = createAbortableOperationTracker();

  const slack: SlackRequestCall = async (method, token, body) => {
    return slackRequests.run((signal) => callSlackApi(method, token, body, { signal }));
  };

  function reset(): void {
    slackRequests = createAbortableOperationTracker();
  }

  async function abortAndWait(): Promise<void> {
    await slackRequests.abortAndWait();
  }

  return {
    slack,
    reset,
    abortAndWait,
  };
}
