import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { chatTimeline } from "./chat";

const FIRST_EXCHANGE = "bubble-2";
const HOLD_SECONDS = 2.2;
const END_SECONDS = 3.4;
const TILT_DEGREES = 7;

/** The first exchange is already on the page; this carries the conversation on from there, then starts it over. */
export function heroChat(root: HTMLElement): void {
  const phone = root.querySelector<HTMLElement>(".hero__phone")!;
  const chat = root.querySelector<HTMLElement>(".chat")!;
  const viewport = chat.querySelector(".chat__viewport");
  const timeline = chatTimeline(chat).seek(FIRST_EXCHANGE);
  let waiting = gsap.delayedCall(HOLD_SECONDS, play);
  let playing = false;

  function play() {
    playing = true;
    timeline.play();
  }

  function rewind() {
    gsap
      .timeline({ onComplete: () => (waiting = gsap.delayedCall(HOLD_SECONDS, play)) })
      .to(viewport, { autoAlpha: 0, duration: 0.35, ease: "power2.in" })
      .call(() => {
        timeline.pause().seek(FIRST_EXCHANGE);
      })
      .to(viewport, { autoAlpha: 1, duration: 0.45, ease: "power2.out" });
  }

  timeline.eventCallback("onComplete", () => {
    playing = false;
    waiting = gsap.delayedCall(END_SECONDS, rewind);
  });

  ScrollTrigger.create({
    trigger: root,
    start: "top bottom",
    end: "bottom top",
    onToggle: ({ isActive }) => {
      waiting.paused(!isActive);
      if (playing) timeline.paused(!isActive);
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
