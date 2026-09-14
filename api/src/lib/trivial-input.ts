import { envInt } from "./env.js";
// Trivial-input gate for PROACTIVE agent wakes.
//
// A plain channel post with no @mention fires a `channel_post` trigger at every
// agent in the room — each one a full LLM turn. On live, the only model work in
// a three-hour window was four agents composing replies to a single 👏: four
// runs, four context packets, four gateway calls, to answer applause.
//
// A clap, a "+1", a "ok thanks" or a bare emoji carries no instruction. It is
// still a real message (it posts, it notifies, it shows up in context on the
// next genuine wake) — it just does not deserve a model call of its own.
//
// Scope is deliberately narrow: this ONLY gates the proactive, nobody-asked-me
// wake. A direct @mention, a DM, a task comment or an assignment always fires,
// however short — "@ben ship it" is eight characters and is an instruction.

// Below this many meaningful characters a message cannot carry an instruction
// worth a model call. Tunable for deployments with terser teams.
export const TRIVIAL_MAX_CHARS = envInt("CC_TRIVIAL_INPUT_MAX_CHARS", 10, { min: 0 });

// Pure acknowledgements. Matched after normalisation (lowercased, punctuation
// and emoji stripped), so "Thanks!!" and "thanks" are the same entry.
const ACKS = new Set([
  "ok", "okay", "k", "kk", "yes", "no", "yep", "yup", "nope", "sure",
  "ty", "thanks", "thank you", "thx", "cheers", "np", "yw",
  "nice", "cool", "great", "awesome", "amazing", "love it", "lol", "haha",
  "done", "same", "agreed", "agree", "this", "wow", "congrats", "gg",
  "1", "plus1", "+1", "ditto", "noted", "got it", "sounds good", "lgtm",
]);

// Emoji, variation selectors, ZWJ, skin-tone modifiers, regional indicators.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2600}-\u{27BF}]/gu;

/** Strip emoji, markdown punctuation and whitespace down to the actual words. */
export function meaningfulText(bodyMd: string): string {
  return String(bodyMd ?? "")
    .replace(EMOJI_RE, " ")
    // markdown emphasis / quoting / list bullets carry no meaning on their own
    .replace(/[*_~`>#\-|]/g, " ")
    .replace(/[!?.,;:()[\]{}'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a message is too thin to be worth waking an agent's model for.
 *
 * Anything containing an @mention, a link, a code fence or an attachment
 * reference is never trivial regardless of length — those are always the point
 * of the message. Callers pass `hasAttachments` when the post carried files.
 */
export function isTrivialInput(
  bodyMd: string,
  opts: { hasAttachments?: boolean } = {},
): boolean {
  const raw = String(bodyMd ?? "");
  if (opts.hasAttachments) return false;
  if (/@[a-z0-9]/i.test(raw)) return false;
  if (/https?:\/\//i.test(raw)) return false;
  if (/```/.test(raw)) return false;

  const text = meaningfulText(raw);
  if (!text) return true; // emoji-only, or an empty/whitespace post
  const normalised = text.toLowerCase();
  if (ACKS.has(normalised)) return true;
  return normalised.length < TRIVIAL_MAX_CHARS;
}
