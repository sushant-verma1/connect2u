/** shadcn/ui's usual `cn()`, minus the `clsx`/`tailwind-merge` dependencies — this
 * project only ever passes a handful of static classes plus conditionals, so a plain
 * filter+join covers it without pulling in class-conflict resolution it doesn't need. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
