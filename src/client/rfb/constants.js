/**
 * RFB protocol constants.
 *
 * Values are the wire numbers fixed by the RFB specification; none of them are
 * negotiable. Pseudo-encodings are the negative numbers the protocol reserves
 * for capabilities rather than data.
 */

/** Version this client offers: 3.8, the newest with no extra transport. */
export const RFB_VERSION = "RFB 003.008\n";

/** Security types. */
export const SECURITY_INVALID = 0;
export const SECURITY_NONE = 1;
export const SECURITY_VNC_AUTH = 2;

/** Server-initiated message types. */
export const MSG_FRAMEBUFFER_UPDATE = 0;
export const MSG_SET_COLOUR_MAP = 1;
export const MSG_BELL = 2;
export const MSG_SERVER_CUT_TEXT = 3;

/** Real encodings this client decodes. */
export const ENCODING_RAW = 0;
export const ENCODING_COPY_RECT = 1;
export const ENCODING_RRE = 2;
export const ENCODING_HEXTILE = 4;
export const ENCODING_ZLIB = 6;
export const ENCODING_TIGHT = 7;
export const ENCODING_ZRLE = 16;

/**
 * Pseudo-encodings.
 *
 * Note what is deliberately NOT here: encoding 21 (JPEG). A Tight update is
 * JPEG-compressed only when the client has advertised 21, so leaving it out of
 * SetEncodings is what keeps the server on the zlib paths this client can
 * decode without shipping a JPEG decoder.
 */
export const PSEUDO_LAST_RECT = -224;
export const PSEUDO_CURSOR = -239;
export const PSEUDO_DESKTOP_SIZE = -223;
export const PSEUDO_EXT_DESKTOP_SIZE = -308;

/** Key flags in a PointerEvent message. */
export const BUTTON1_MASK = 1;
export const BUTTON2_MASK = 2;
export const BUTTON3_MASK = 4;
export const BUTTON4_MASK = 8;
export const BUTTON5_MASK = 16;

/** Coordinate clamp used before sending any pointer message. */
export const COORD_MAX = 0xffff;
