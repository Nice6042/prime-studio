import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_RESIDENT_TIMELINE_ITEMS } from "../reducer";
import { Message } from "./Message";
import type { ChildActions } from "./ToolCard";
import type { ChildState, TimelineItem, ToolState } from "../types";

const NEAR_BOTTOM = 80;

function boundedRenderedRows(timeline: TimelineItem[]): {
  timeline: TimelineItem[];
  omittedRows: boolean;
  rowCount: number;
} {
  let remaining = MAX_RESIDENT_TIMELINE_ITEMS;
  let omittedRows = false;
  const retained: TimelineItem[] = [];
  for (let index = timeline.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = timeline[index];
    if (item.kind !== "assistant") {
      retained.push(item);
      remaining -= 1;
      continue;
    }
    if (item.blocks.length === 0) {
      retained.push(item);
      remaining -= 1;
      continue;
    }
    const blocks = item.blocks.slice(-remaining);
    omittedRows ||= blocks.length < item.blocks.length;
    retained.push(blocks.length === item.blocks.length ? item : { ...item, blocks });
    remaining -= blocks.length;
  }
  omittedRows ||= retained.length < timeline.length;
  return {
    timeline: retained.reverse(),
    omittedRows,
    rowCount: MAX_RESIDENT_TIMELINE_ITEMS - remaining,
  };
}

export function MessageList({
  timeline,
  tools,
  children,
  busy,
  actions,
  omittedItems,
  totalItems,
  payloadTruncated,
  windowStart = Math.max(0, totalItems - timeline.length),
  windowEnd = totalItems,
  hasOlder = false,
  hasNewer = false,
  onOlder,
  onLatest,
  empty,
}: {
  timeline: TimelineItem[];
  tools: Record<string, ToolState>;
  children: ChildState[];
  busy: boolean;
  actions: ChildActions;
  omittedItems: number;
  totalItems: number;
  payloadTruncated: boolean;
  windowStart?: number;
  windowEnd?: number;
  hasOlder?: boolean;
  hasNewer?: boolean;
  onOlder?: () => void;
  onLatest?: () => void;
  empty: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [responseAnnouncement, setResponseAnnouncement] = useState("");
  const wasBusy = useRef(busy);
  // Reducer state is already bounded. This second boundary protects the DOM if
  // another caller supplies an unbounded array directly.
  const windowed = boundedRenderedRows(timeline.slice(-MAX_RESIDENT_TIMELINE_ITEMS));
  const residentTimeline = windowed.timeline;
  const childSlots = Math.max(0, MAX_RESIDENT_TIMELINE_ITEMS - windowed.rowCount);
  const residentChildren = childSlots === 0 ? [] : children.slice(-childSlots);
  const omittedChildRows = residentChildren.length < children.length;
  const truthfulTotal = Math.max(totalItems, timeline.length + omittedItems);
  const effectiveOmitted = Math.max(omittedItems, truthfulTotal - residentTimeline.length);
  // Only the closing assistant message can hold a verdict; see `isVerdict`.
  let lastAssistant = -1;
  residentTimeline.forEach((t, i) => {
    if (t.kind === "assistant") lastAssistant = i;
  });
  const finalAssistant = lastAssistant < 0 ? null : residentTimeline[lastAssistant];
  const finalAssistantKey = finalAssistant?.kind === "assistant" ? finalAssistant.key : null;
  const lastObservedAssistantKey = useRef(finalAssistantKey);
  const cycleAssistantKey = useRef<string | null>(
    busy && finalAssistant?.kind === "assistant" && finalAssistant.streaming
      ? finalAssistant.key
      : null,
  );

  // Streamed chunks stay in the reading order but out of the live region. Only
  // announce after the completed answer has replaced the stream.
  useEffect(() => {
    if (busy) {
      if (!wasBusy.current) {
        cycleAssistantKey.current =
          finalAssistantKey !== lastObservedAssistantKey.current
            ? finalAssistantKey
            : finalAssistant?.kind === "assistant" && finalAssistant.streaming
              ? finalAssistant.key
              : null;
      } else if (
        finalAssistantKey &&
        finalAssistantKey !== lastObservedAssistantKey.current
      ) {
        cycleAssistantKey.current = finalAssistantKey;
      }
      setResponseAnnouncement("");
    } else if (wasBusy.current) {
      const completedAssistantKey =
        cycleAssistantKey.current ??
        (finalAssistantKey !== lastObservedAssistantKey.current ? finalAssistantKey : null);
      if (
        completedAssistantKey &&
        completedAssistantKey === finalAssistantKey &&
        finalAssistant?.kind === "assistant" &&
        !finalAssistant.streaming
      ) {
        setResponseAnnouncement("Prime finished responding. The final answer is ready.");
      }
    }
    lastObservedAssistantKey.current = finalAssistantKey;
    wasBusy.current = busy;
  }, [busy, finalAssistant, finalAssistantKey]);

  // Autoscroll follows the stream, but yields the moment the user scrolls up.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(gap < NEAR_BOTTOM);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      className="messages"
      ref={ref}
      role="log"
      aria-label="Conversation transcript"
      aria-live="off"
      aria-relevant="additions text"
      tabIndex={0}
    >
      <div
        className="sr-only"
        role="status"
        aria-label="Response status"
        aria-live="polite"
        aria-atomic="true"
      >
        {responseAnnouncement}
      </div>
      {residentTimeline.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <div className="reading">
          {(effectiveOmitted > 0 ||
            payloadTruncated ||
            windowed.omittedRows ||
            omittedChildRows) && (
            <p className="notice" role="status" aria-live="off">
              {effectiveOmitted > 0 && (
                <>
                  {hasNewer ? (
                    <>
                      Showing messages {(windowStart + 1).toLocaleString()}–
                      {windowEnd.toLocaleString()} of {truthfulTotal.toLocaleString()}.
                    </>
                  ) : (
                    <>
                      Showing the latest {residentTimeline.length.toLocaleString()} of{" "}
                      {truthfulTotal.toLocaleString()} messages.
                    </>
                  )}{" "}
                  Other messages remain in the source session but are not resident in this view.
                </>
              )}
              {effectiveOmitted > 0 && payloadTruncated ? " " : null}
              {payloadTruncated && (
                <>Very large message content was clipped in this view; the source session is unchanged.</>
              )}
              {(effectiveOmitted > 0 || payloadTruncated) && windowed.omittedRows ? " " : null}
              {windowed.omittedRows && (
                <>Older retained content rows are not mounted in this view.</>
              )}
              {(effectiveOmitted > 0 || payloadTruncated || windowed.omittedRows) &&
              omittedChildRows
                ? " "
                : null}
              {omittedChildRows && <>Older child rows are not mounted in this view.</>}
            </p>
          )}
          {(hasOlder || hasNewer) && (
            <nav className="notice" aria-label="Transcript pages">
              {hasOlder && <button onClick={onOlder}>Previous 300 messages</button>}
              {hasNewer && <button onClick={onLatest}>Jump to latest messages</button>}
            </nav>
          )}
          {residentTimeline.map((item, i) => (
            <Message
              key={item.key}
              item={item}
              tools={tools}
              children={residentChildren}
              busy={busy}
              last={!hasNewer && i === lastAssistant}
              quiet={Object.keys(tools).length === 0 && children.length === 0}
              actions={actions}
            />
          ))}
        </div>
      )}
      {!pinned && (
        <button
          className="jump"
          onClick={() => {
            setPinned(true);
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
