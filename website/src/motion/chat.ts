import gsap from "gsap";
import { richReveal } from "./bubbles";

const TYPING_SECONDS = 0.7;
const HOLD_SECONDS = 0.5;
const SECONDS_PER_LETTER = 0.026;
const MAX_DRAFT_SECONDS = 1.3;

function showDraft(input: HTMLElement, text: string): void {
  input.querySelector(".chat__draft")!.textContent = text;
  input.dataset.typing = String(text.length > 0);
  const field = input.querySelector(".chat__field")!;
  field.scrollLeft = field.scrollWidth;
}

/** Types a message into the input bar. It tweens a plain number, so scrolling backwards un-types it. */
function addDraft(timeline: gsap.core.Timeline, input: HTMLElement, text: string): void {
  const draft = { letters: 0 };
  const render = () => showDraft(input, text.slice(0, Math.round(draft.letters)));
  timeline
    .to(draft, {
      letters: text.length,
      duration: Math.min(MAX_DRAFT_SECONDS, text.length * SECONDS_PER_LETTER),
      ease: "none",
      onUpdate: render,
    })
    .to(draft, { letters: 0, duration: 0.01, ease: "none", onUpdate: render });
}

/**
 * The reveal of one chat thread, paused. The hero plays it, the day story scrubs it, the feature picker restarts it.
 * Call it while the chat is laid out (visibility: hidden is fine, display: none is not): it measures the bubbles.
 */
export function chatTimeline(chat: HTMLElement): gsap.core.Timeline {
  const viewport = chat.querySelector<HTMLElement>(".chat__viewport")!;
  const list = chat.querySelector<HTMLElement>(".chat__list")!;
  const typing = chat.querySelector<HTMLElement>(".chat__typing")!;
  const input = chat.querySelector<HTMLElement>(".chat__input")!;
  const bubbles = gsap.utils.toArray<HTMLElement>(".bubble", list);
  const timeline = gsap.timeline({ paused: true, defaults: { ease: "expo.out" } });

  gsap.set(bubbles, { autoAlpha: 0, y: 14, scale: 0.97 });
  gsap.set(list, { y: 0 });
  let shift = 0;

  for (const bubble of bubbles) {
    const mine = bubble.dataset.from === "me";
    gsap.set(bubble, { transformOrigin: mine ? "100% 100%" : "0% 100%" });
    const text = bubble.querySelector(".bubble__text")?.textContent ?? "";
    if (mine && bubble.dataset.kind === "text") addDraft(timeline, input, text);
    if (!mine) {
      timeline
        .set(typing, { top: Math.min(bubble.offsetTop + shift, viewport.clientHeight - 44), autoAlpha: 1 })
        .to({}, { duration: TYPING_SECONDS })
        .set(typing, { autoAlpha: 0 });
    }
    // Newest message sits at the bottom, as in a real chat. Moving the list keeps this to transforms.
    const bottom = bubble.offsetTop + bubble.offsetHeight + 12;
    const y = Math.min(0, viewport.clientHeight - bottom);
    timeline
      .to(list, { y, duration: 0.45 })
      .to(bubble, { autoAlpha: 1, y: 0, scale: 1, duration: 0.5 }, "<")
      .add(richReveal(bubble), "-=0.3")
      .to({}, { duration: HOLD_SECONDS });
    shift = y;
  }
  return timeline;
}

/** Starts a thread over, clearing whatever was half typed when it was interrupted. */
export function replay(timeline: gsap.core.Timeline, chat: HTMLElement): void {
  showDraft(chat.querySelector<HTMLElement>(".chat__input")!, "");
  timeline.restart();
}
