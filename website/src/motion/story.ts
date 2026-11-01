import gsap from "gsap";
import { chatTimeline } from "./chat";

const SWAP_SECONDS = 0.6;
const CHAT_SECONDS = 3.2;
const LAST_HOLD_SECONDS = 0.8;

let chats: HTMLElement[] | undefined;

/** Turns the plain list of scenes into a sticky stage and ties the whole day to the scrollbar. */
export function dayStory(root: HTMLElement): () => void {
  const scenes = gsap.utils.toArray<HTMLElement>(".scene", root);
  const phone = root.querySelector<HTMLElement>(".story__phone")!;
  const clock = phone.querySelector<HTMLElement>(".phone__clock")!;
  const sun = document.querySelector<HTMLElement>(".sun--day")!;
  root.classList.add("is-live");

  // One phone for the whole day: every scene's chat moves into it, once, and stays there across rebuilds.
  const screen = phone.querySelector<HTMLElement>(".phone__screen")!;
  chats ??= scenes.map((scene) => screen.appendChild(scene.querySelector<HTMLElement>(".chat")!));

  gsap.set(scenes.slice(1), { autoAlpha: 0 });
  gsap.set(chats.slice(1), { autoAlpha: 0 });
  gsap.set(sun, { x: "64vw", y: "42vh" });

  const master = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: root.querySelector(".story__track"),
      start: "top top",
      end: "bottom bottom",
      scrub: 0.5,
      onUpdate: ({ progress }) => {
        const scene = Math.min(scenes.length - 1, Math.floor(progress * scenes.length));
        clock.textContent = scenes[scene].dataset.time ?? "";
      },
    },
  });

  scenes.forEach((scene, i) => {
    const label = `scene-${i}`;
    const sky = document.querySelector(`.sky__layer[data-sky="${scene.dataset.sky}"]`);
    master.addLabel(label);
    if (i > 0) {
      master
        .to(scenes[i - 1], { autoAlpha: 0, y: -28, duration: SWAP_SECONDS, ease: "power2.in" }, label)
        .fromTo(scene, { autoAlpha: 0, y: 36 }, { autoAlpha: 1, y: 0, duration: SWAP_SECONDS, ease: "power2.out" }, `${label}+=0.2`)
        .to(chats![i - 1], { autoAlpha: 0, xPercent: -10, duration: SWAP_SECONDS }, label)
        .fromTo(chats![i], { autoAlpha: 0, xPercent: 12 }, { autoAlpha: 1, xPercent: 0, duration: SWAP_SECONDS, ease: "power2.out" }, label);
      if (sky) master.to(sky, { opacity: 1, duration: SWAP_SECONDS * 1.5 }, label);
    }
    master.add(chatTimeline(chats![i]).paused(false).duration(CHAT_SECONDS), `${label}+=${i > 0 ? SWAP_SECONDS : 0.1}`);
  });
  master.to({}, { duration: LAST_HOLD_SECONDS });

  const day = master.duration();
  master
    .to(sun, { x: "44vw", y: "6vh", duration: day * 0.42, ease: "sine.out" }, 0)
    .to(sun, { x: "86vw", y: "98vh", duration: day * 0.44, ease: "sine.in" }, day * 0.42)
    .to(sun, { autoAlpha: 0, duration: day * 0.08 }, day * 0.8);

  return () => root.classList.remove("is-live");
}
