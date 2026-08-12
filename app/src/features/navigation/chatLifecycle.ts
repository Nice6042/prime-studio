import type { ProjectChat } from "../../domain/projectChats";
import type { SessionEntities } from "../../entities/sessions/sessionStore";

export type NavigationChatStatus = "idle" | "working" | "live" | "error" | "unavailable";

export interface ChatLifecycleProjection {
  readonly status: NavigationChatStatus;
  readonly label: "Idle" | "Working" | "Live" | "Error" | "Unavailable";
  readonly detail: string;
}

const lifecycle = (status: NavigationChatStatus, label: ChatLifecycleProjection["label"], detail: string): ChatLifecycleProjection =>
  Object.freeze({ status, label, detail });

export function projectChatLifecycle(chat: ProjectChat, sessions: SessionEntities): ChatLifecycleProjection {
  const binding = chat.binding;
  if (!binding) return lifecycle("idle", "Idle", "No Harness session has been started for this chat.");
  const session = sessions[binding.sessionId];
  if (!session) return lifecycle("unavailable", "Unavailable", "Bound Harness session evidence is unavailable.");
  if (session.accountId !== binding.accountId || binding.agentId !== null && session.chatId !== binding.agentId) {
    return lifecycle("unavailable", "Unavailable", "Harness session identity does not match this chat binding.");
  }
  if (session.freshness === "stale") return lifecycle("unavailable", "Unavailable", "Harness lifecycle evidence is stale.");
  if (session.freshness === "unknown_outcome") return lifecycle("unavailable", "Unavailable", "Harness lifecycle outcome is unavailable.");
  if (session.freshness === "disconnected" || session.state === "disconnected") {
    return lifecycle("error", "Error", "Harness session disconnected.");
  }
  if (session.workerRecovery.status === "starting") {
    return lifecycle("working", "Working", "Worker is starting; the verified supervisor has not reported it ready.");
  }
  if (session.workerRecovery.status === "recovering") {
    return lifecycle("working", "Working", "The verified supervisor is recovering this chat after an unexpected worker stop.");
  }
  if (session.workerRecovery.status === "retryable_failure") {
    return lifecycle("working", "Working", "Supervisor recovery was exhausted; the one safe retry is pending.");
  }
  if (session.workerRecovery.status === "retrying") {
    return lifecycle("working", "Working", "Prime Studio is retrying this chat's worker once.");
  }
  if (session.workerRecovery.status === "terminal_failure") {
    const reason = session.workerRecovery.detail?.trim();
    return lifecycle("error", "Error", `Worker recovery failed.${reason ? ` ${reason}` : " No safe retry remains."}`);
  }
  if (session.state === "failed") return lifecycle("error", "Error", "Harness session failed.");
  if (session.state === "stopped") return lifecycle("error", "Error", "Harness session stopped.");
  if (session.state === "blocked") return lifecycle("working", "Working", "Harness is active and waiting on a blocking condition.");
  if (session.state === "working") return lifecycle("working", "Working", "Harness is processing this chat.");
  return lifecycle("live", "Live", "Harness session is connected and ready.");
}
