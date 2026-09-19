import { Link } from "react-router-dom";
import { ScrollFilm } from "./home/ScrollFilm";

const PRIMARY_CTA =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md bg-slate-900 px-5 py-2.5 " +
  "text-sm font-medium text-white transition hover:bg-slate-800 active:translate-y-px " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900";

const SECONDARY_CTA =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md border border-slate-300 " +
  "bg-white px-5 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-100 " +
  "active:translate-y-px focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-slate-900";

const NAV_LINK =
  "rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 " +
  "hover:text-slate-900 focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-slate-900";

const CAPABILITIES = [
  {
    title: "Adaptive routing",
    body: "Channel order shifts with observed delivery and verification outcomes, not a fixed list written once.",
  },
  {
    title: "Automatic fallback",
    body: "When an attempt does not complete in time, the next channel takes over carrying the same code.",
  },
  {
    title: "Provider independent",
    body: "Routing policy lives outside any single messaging provider, so swapping one changes nothing else.",
  },
  {
    title: "Observable decisions",
    body: "Every attempt records which channels were considered, which one was chosen, and why.",
  },
] as const;

/** `overflow-x-clip` and not `overflow-x-hidden` on the root: hidden makes the element
 * a scroll container, which silently kills `position: sticky` for both the nav and the
 * film's pin. */
export function HomePage() {
  return (
    <div className="min-h-[100dvh] overflow-x-clip bg-white text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <nav
          aria-label="Main"
          className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8"
        >
          <Link
            to="/"
            className="rounded-md text-base font-semibold tracking-tight text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-900"
          >
            Connect2U
          </Link>
          <div className="flex items-center gap-1">
            <Link to="/demo/routing" className={NAV_LINK}>
              Demo
            </Link>
            <Link to="/login" className={NAV_LINK}>
              Sign in
            </Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-12 sm:px-8 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-20 lg:pt-20">
          <div>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tighter text-slate-900 sm:text-5xl lg:text-6xl">
              Intelligent OTP routing
            </h1>
            <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-slate-600 sm:text-lg">
              Connect2U picks the channel for each verification, falls back when delivery stalls,
              and adapts from the outcomes.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/demo/routing" className={PRIMARY_CTA}>
                Try live demo
              </Link>
              <Link to="/login" className={SECONDARY_CTA}>
                Sign in
              </Link>
            </div>
          </div>

          <img
            src="/intro/f_089.webp"
            alt="Routing loop: a request reaches the router, the router sends on a channel, the phone verifies the code, and the outcome returns to the router."
            width={1280}
            height={720}
            fetchPriority="high"
            className="w-full [mask-image:radial-gradient(115%_100%_at_50%_50%,#000_58%,transparent_100%)]"
          />
        </section>

        <ScrollFilm />

        <section className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
            <h2 className="reveal max-w-[20ch] text-3xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              Every delivery becomes feedback for the next decision.
            </h2>

            <div className="mt-12 grid gap-4 md:grid-cols-6">
              <article className="reveal flex flex-col justify-between gap-6 rounded-lg border border-slate-200 bg-white p-6 sm:p-8 md:col-span-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight text-slate-900">
                    {CAPABILITIES[0].title}
                  </h3>
                  <p className="mt-2 max-w-[50ch] leading-relaxed text-slate-600">
                    {CAPABILITIES[0].body}
                  </p>
                </div>
                <img
                  src="/intro/router-still.webp"
                  alt="The router choosing between WhatsApp, SMS, and voice for one request."
                  width={620}
                  height={560}
                  loading="lazy"
                  className="mx-auto h-36 w-auto sm:h-44"
                />
              </article>

              <article className="reveal rounded-lg border border-slate-200 bg-white p-6 sm:p-8 md:col-span-2">
                <h3 className="text-lg font-semibold tracking-tight text-slate-900">
                  {CAPABILITIES[1].title}
                </h3>
                <p className="mt-2 leading-relaxed text-slate-600">{CAPABILITIES[1].body}</p>
              </article>

              {CAPABILITIES.slice(2).map((capability) => (
                <article
                  key={capability.title}
                  className="reveal rounded-lg border border-slate-200 bg-white p-6 sm:p-8 md:col-span-3"
                >
                  <h3 className="text-lg font-semibold tracking-tight text-slate-900">
                    {capability.title}
                  </h3>
                  <p className="mt-2 max-w-[55ch] leading-relaxed text-slate-600">
                    {capability.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-slate-200 bg-white">
          <div className="reveal mx-auto max-w-2xl px-5 py-20 text-center sm:px-8 lg:py-28">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
              See the router adapt
            </h2>
            <p className="mx-auto mt-4 max-w-[52ch] leading-relaxed text-slate-600">
              Route three verifications yourself, then hand the next ten to Connect2U and watch the
              channel order change as the outcomes come in. No account needed.
            </p>
            <div className="mt-8 flex justify-center">
              <Link to="/demo/routing" className={PRIMARY_CTA}>
                Try live demo
              </Link>
            </div>
            <p className="mt-6 text-sm text-slate-500">
              Delivery is simulated. No real SMS or WhatsApp message is sent.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="text-sm font-semibold tracking-tight text-slate-900">Connect2U</p>
          <div className="flex gap-4 text-sm">
            <Link
              to="/demo/routing"
              className="rounded text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              Demo
            </Link>
            <Link
              to="/login"
              className="rounded text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              Sign in
            </Link>
            <Link
              to="/signup"
              className="rounded text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              Create account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
