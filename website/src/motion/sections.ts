import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * A short entrance for a group of elements. They stay visible unless this runs, so nothing depends on it firing, and
 * only opacity changes, so a keyboard can still reach them before they've been scrolled to.
 */
function enter(selector: string, trigger: string): void {
  gsap.from(selector, {
    opacity: 0,
    y: 28,
    duration: 0.9,
    stagger: 0.08,
    ease: "expo.out",
    scrollTrigger: { trigger, start: "top 80%", once: true },
  });
}

export function pageMotion(): void {
  enter(".picker__tab", ".picker__tabs");
  enter(".limits li", ".limits__list");

  // The line runs along the steps: sideways on wide screens, downwards on phones.
  const line = document.querySelector(".steps__line");
  if (line) {
    gsap.matchMedia().add({ wide: "(min-width: 900px)", narrow: "(max-width: 899px)" }, ({ conditions }) => {
      const scale = conditions?.wide ? "scaleX" : "scaleY";
      gsap.fromTo(line, { [scale]: 0 }, {
        [scale]: 1,
        ease: "none",
        scrollTrigger: { trigger: ".steps__rail", start: "top 75%", end: "bottom 60%", scrub: true },
      });
    });
    gsap.from(".step__number", {
      scale: 0.4,
      stagger: 0.25,
      duration: 0.7,
      ease: "expo.out",
      scrollTrigger: { trigger: ".steps__rail", start: "top 72%", once: true },
    });
  }

  // Night turns back into morning, and the sun comes up behind the last sentence. It waits until the FAQ's white text
  // has mostly left the screen, and the dark headline only appears once the sky behind it is light enough.
  const dawn = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: { trigger: ".final", start: "top 50%", end: "bottom bottom", scrub: 0.5 },
  });
  dawn
    .to('.sky__layer[data-sky="fajar"]', { opacity: 1, duration: 0.7 }, 0)
    .fromTo(".sun--dawn", { y: "26vmin" }, { y: 0, duration: 1 }, 0)
    .fromTo(".final h2, .final .button", { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.1 }, 0.35);

  const stickyCta = document.querySelector(".sticky-cta");
  if (stickyCta) {
    gsap.set(stickyCta, { yPercent: 160, autoAlpha: 0 });
    const show = gsap.to(stickyCta, { yPercent: 0, autoAlpha: 1, duration: 0.45, ease: "expo.out", paused: true });
    // Hidden through the day story, where it would sit on top of the phone.
    ScrollTrigger.create({
      trigger: ".night",
      start: "top 70%",
      endTrigger: ".final",
      end: "top 60%",
      onToggle: ({ isActive }) => (isActive ? show.play() : show.reverse()),
    });
  }
}
