import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { chatTimeline, replay } from "./chat";

const FIRST_HOLD_SECONDS = 2.2;
const BETWEEN_SECONDS = 2.6;
const TILT_DEGREES = 7;

/** The first conversation is already on the page; this only moves on to the next ones, then repeats. */
export function heroChat(root: HTMLElement): void {
  const scenarios = gsap.utils.toArray<HTMLElement>(".hero__chat", root);
  const phone = root.querySelector<HTMLElement>(".hero__phone")!;
  const timelines = new Map<number, gsap.core.Timeline>();
  let index = 0;
  let waiting = gsap.delayedCall(FIRST_HOLD_SECONDS, next);
  let playing: gsap.core.Timeline | undefined;

  for (const scenario of scenarios.slice(1)) {
    scenario.hidden = false;
    gsap.set(scenario, { autoAlpha: 0 });
  }

  function next() {
    const from = scenarios[index];
    index = (index + 1) % scenarios.length;
    const to = scenarios[index];
    const chat = to.querySelector<HTMLElement>(".chat")!;
    const timeline = timelines.get(index) ?? chatTimeline(chat);
    timelines.set(index, timeline);
    gsap.to(from, { autoAlpha: 0, duration: 0.35, ease: "power2.out" });
    gsap.set(to, { autoAlpha: 1 });
    playing = timeline;
    timeline.eventCallback("onComplete", () => {
      waiting = gsap.delayedCall(BETWEEN_SECONDS, next);
    });
    replay(timeline, chat);
  }

  ScrollTrigger.create({
    trigger: root,
    start: "top bottom",
    end: "bottom top",
    onToggle: ({ isActive }) => {
      waiting.paused(!isActive);
      playing?.paused(!isActive);
    },
  });

  gsap.to(phone, {
    y: -56,
    scale: 0.95,
    ease: "none",
    scrollTrigger: { trigger: root, start: "top top", end: "bottom top", scrub: true },
  });

  if (!matchMedia("(pointer: fine)").matches) return;
  const turnY = gsap.quickTo(phone, "rotationY", { duration: 0.9, ease: "power3" });
  const turnX = gsap.quickTo(phone, "rotationX", { duration: 0.9, ease: "power3" });
  root.addEventListener("pointermove", (event) => {
    turnY((event.clientX / innerWidth - 0.5) * TILT_DEGREES);
    turnX((0.5 - event.clientY / innerHeight) * TILT_DEGREES);
  });
  root.addEventListener("pointerleave", () => {
    turnY(0);
    turnX(0);
  });
}
