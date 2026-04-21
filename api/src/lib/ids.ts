import { customAlphabet } from "nanoid";

const alpha = "0123456789abcdefghijklmnopqrstuvwxyz";
const nid = customAlphabet(alpha, 20);

export const id = (prefix: string): string => `${prefix}_${nid()}`;
export const rawToken = (len = 40): string => customAlphabet(alpha, len)();
