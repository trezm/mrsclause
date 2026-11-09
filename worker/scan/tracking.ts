// Tracking-number helpers: clean up, guess the carrier, and build a link.

import { squash } from "../lib/util";

export type Carrier = "UPS" | "USPS" | "FedEx" | "DHL" | "Amazon" | "OnTrac" | "LaserShip" | "Canada Post" | "Royal Mail";

const PATTERNS: [Carrier, RegExp][] = [
  ["UPS", /^1Z[0-9A-Z]{16}$/],
  ["Amazon", /^TBA\d{9,15}$/],
  ["USPS", /^(9[1-5]\d{18,24}|82\d{8}|[A-Z]{2}\d{9}US)$/],
  ["OnTrac", /^[CD]\d{14}$/],
  ["LaserShip", /^(1LS[0-9A-Z]{9,}|L[A-Z]\d{8})$/],
  ["FedEx", /^(\d{12}|\d{15}|96\d{20}|\d{20})$/],
  ["DHL", /^(\d{10,11}|JJD\d{9,}|GM\d{16,})$/],
];

const CARRIER_ALIASES: [RegExp, Carrier][] = [
  [/\bups\b|united parcel/i, "UPS"],
  [/usps|postal service|\bpost office\b/i, "USPS"],
  [/fed\s?ex/i, "FedEx"],
  [/\bdhl\b/i, "DHL"],
  [/amazon/i, "Amazon"],
  [/ontrac/i, "OnTrac"],
  [/lasership/i, "LaserShip"],
  [/canada post/i, "Canada Post"],
  [/royal mail/i, "Royal Mail"],
];

export function normalizeTrackingNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function looksLikeTrackingNumber(value: string): boolean {
  return value.length >= 8 && value.length <= 40 && /\d/.test(value);
}

export function detectCarrier(trackingNumber: string, hint?: string | null): Carrier | null {
  if (hint) {
    for (const [pattern, carrier] of CARRIER_ALIASES) if (pattern.test(hint)) return carrier;
  }
  for (const [carrier, pattern] of PATTERNS) if (pattern.test(trackingNumber)) return carrier;
  return null;
}

export function trackingUrl(carrier: string | null, trackingNumber: string): string {
  const n = encodeURIComponent(trackingNumber);
  switch (carrier) {
    case "UPS":
      return `https://www.ups.com/track?tracknum=${n}`;
    case "USPS":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case "FedEx":
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case "DHL":
      return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`;
    case "Amazon":
      return `https://track.amazon.com/tracking/${n}`;
    case "OnTrac":
      return `https://www.ontrac.com/tracking/?number=${n}`;
    case "Canada Post":
      return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`;
    case "Royal Mail":
      return `https://www.royalmail.com/track-your-item#/tracking-results/${n}`;
    default:
      return `https://parcelsapp.com/en/tracking/${n}`;
  }
}

/**
 * True when the value is literally present in the email (ignoring spaces and
 * punctuation). Used to drop order or tracking numbers the model made up.
 */
export function appearsIn(value: string, squashedText: string): boolean {
  const needle = squash(value);
  return needle.length > 0 && squashedText.includes(needle);
}
