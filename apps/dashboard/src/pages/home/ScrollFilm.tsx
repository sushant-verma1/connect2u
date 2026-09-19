import { useEffect, useRef, useState } from "react";

/** Frames sliced from the OTP routing motion graphic at 12fps into public/intro. They
 * are line art on white, so the whole sequence is ~1.4MB — small enough to scrub from
 * memory, which is what makes the scroll feel attached to the pointer instead of
 * streaming. To regenerate from a new cut (the 7.8s trim drops the source's closing
 * text card, which would fight the captions below):
 *
 *   ffmpeg -t 7.8 -i <source>.mp4 -vf "fps=12,scale=1280:-2" \
 *     -c:v libwebp -quality 76 -preset drawing public/intro/f_%03d.webp
 *
 * then delete any trailing frames where the text card starts fading in, and set
 * FRAME_COUNT plus the chapter fractions below to match. */
const FRAME_COUNT = 89;
const frameSrc = (index: number) => `/intro/f_${String(index + 1).padStart(3, "0")}.webp`;

/** `at` is the scroll fraction where the chapter takes over, read off the source film:
 * request (0s), router decision (1s), delivery (2s), verification (4s), feedback loop
 * (5.9s), over a 7.4s cut. */
const CHAPTERS = [
  {
    at: 0,
    title: "A request arrives",
    body: "One verification, one code, no channel chosen yet.",
  },
  {
    at: 0.13,
    title: "The router weighs the channels",
    body: "Available channels are ranked on what has actually been delivering.",
  },
  {
    at: 0.27,
    title: "It sends on the best-scoring channel",
    body: "If that attempt stalls, the next channel picks up the same code.",
  },
  {
    at: 0.53,
    title: "The code is verified",
    body: "The outcome is recorded against the channel that carried it.",
  },
  {
    at: 0.78,
    title: "The score moves",
    body: "The next request is routed with what this one just proved.",
  },
] as const;

const FILM_LABEL =
  "An OTP request enters Connect2U, the router picks a channel, the message is " +
  "delivered, the code is verified, and the outcome updates that channel's score.";

/** Each chapter's midpoint frame, for the reduced-motion storyboard that replaces the
 * scrub. */
const STORYBOARD = CHAPTERS.map((chapter, index) => {
  const next = CHAPTERS[index + 1];
  const end = next ? next.at : 1;
  return { ...chapter, still: frameSrc(Math.round(((chapter.at + end) / 2) * (FRAME_COUNT - 1))) };
});

function chapterIndexAt(progress: number): number {
  let index = 0;
  CHAPTERS.forEach((chapter, i) => {
    if (progress >= chapter.at) index = i;
  });
  return index;
}

export function ScrollFilm() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const captionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const wrap = wrapRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !stage || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The sequence is only fetched once the film is within reach of the viewport, so
    // it never competes with the hero image for the initial page load.
    let frames: HTMLImageElement[] = [];
    const ensureFrames = () => {
      if (frames.length > 0) return;
      frames = Array.from({ length: FRAME_COUNT }, (_, i) => {
        const image = new Image();
        image.src = frameSrc(i);
        return image;
      });
      frames[0]?.decode().then(
        () => paint(0),
        () => undefined,
      );
    };

    let raf = 0;
    let running = false;
    let lastFrame = -1;
    let lastChapter = -1;
    let cssWidth = 0;
    let cssHeight = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssWidth = canvas.clientWidth;
      cssHeight = canvas.clientHeight;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastFrame = -1;
    };

    const paint = (index: number) => {
      // A frame still in flight would blank the canvas, so hold the nearest earlier
      // frame that has decoded instead.
      let candidate = index;
      while (candidate > 0 && !frames[candidate]?.complete) candidate -= 1;
      const image = frames[candidate];
      if (!image?.complete || image.naturalWidth === 0) return;
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const scale = Math.min(cssWidth / image.naturalWidth, cssHeight / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      ctx.drawImage(image, (cssWidth - width) / 2, (cssHeight - height) / 2, width, height);
      lastFrame = candidate;
    };

    const tick = () => {
      const rect = wrap.getBoundingClientRect();
      const travel = wrap.offsetHeight - window.innerHeight;
      const progress = travel > 0 ? Math.min(Math.max(-rect.top / travel, 0), 1) : 0;

      const frame = Math.round(progress * (FRAME_COUNT - 1));
      if (frame !== lastFrame) paint(frame);

      if (railRef.current) railRef.current.style.transform = `scaleX(${progress})`;

      const chapter = chapterIndexAt(progress);
      if (chapter !== lastChapter) {
        lastChapter = chapter;
        captionRefs.current.forEach((node, i) => {
          if (!node) return;
          const active = i === chapter;
          node.style.opacity = active ? "1" : "0";
          node.style.transform = active ? "none" : "translateY(0.75rem)";
        });
      }

      if (running) raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    // Scrubbing only matters while the pinned stage is on screen; outside that the rAF
    // loop is pure cost.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          ensureFrames();
          start();
        } else {
          stop();
        }
      },
      { rootMargin: "60% 0px" },
    );
    observer.observe(wrap);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    resize();

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [reduced]);

  if (reduced) {
    return (
      <section aria-label="How Connect2U routes a verification" className="bg-white">
        <div className="mx-auto max-w-5xl space-y-12 px-5 py-20 sm:px-8">
          {STORYBOARD.map((chapter) => (
            <figure key={chapter.title} className="space-y-4">
              <img
                src={chapter.still}
                alt=""
                width={1280}
                height={720}
                className="w-full rounded-lg border border-slate-200"
              />
              <figcaption>
                <h3 className="text-lg font-semibold tracking-tight text-slate-900">
                  {chapter.title}
                </h3>
                <p className="mt-1 max-w-[55ch] text-slate-600">{chapter.body}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={wrapRef}
      aria-label="How Connect2U routes a verification"
      className="relative h-[360vh] bg-white md:h-[500vh]"
    >
      <div className="sticky top-0 flex h-[100dvh] flex-col overflow-hidden">
        <div ref={stageRef} className="min-h-0 flex-1 px-4 pb-2 pt-16 sm:px-8 md:pt-20">
          <canvas ref={canvasRef} role="img" aria-label={FILM_LABEL} className="h-full w-full" />
        </div>

        <div className="mx-auto w-full max-w-5xl px-5 pb-10 sm:px-8 sm:pb-14">
          <div className="h-px w-full bg-slate-200">
            <div
              ref={railRef}
              aria-hidden="true"
              className="h-px w-full origin-left scale-x-0 bg-emerald-600"
            />
          </div>
          <div className="relative mt-5 h-24 sm:h-20">
            {CHAPTERS.map((chapter, index) => (
              <div
                key={chapter.title}
                ref={(node) => {
                  captionRefs.current[index] = node;
                }}
                className="absolute inset-x-0 top-0 transition-[opacity,transform] duration-500 ease-out"
                style={{
                  opacity: index === 0 ? 1 : 0,
                  transform: index === 0 ? "none" : "translateY(0.75rem)",
                }}
              >
                <h3 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
                  {chapter.title}
                </h3>
                <p className="mt-1.5 max-w-[55ch] text-sm text-slate-600 sm:text-base">
                  {chapter.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
