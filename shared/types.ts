// Types shared by the Worker API and the React dashboard.

/** Where a gift is in its journey, from "just an idea" to "wrapped". */
export type ItemStatus =
  | "idea"
  | "ordered"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "wrapped"
  | "cancelled";

export type OrderStatus =
  | "ordered"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "returned";

export type ShipmentStatus = "in_transit" | "out_for_delivery" | "delivered" | "exception";

/** How an order line relates to the gift list. */
export type MatchState = "unmatched" | "suggested" | "matched" | "ignored";

export type RiskLevel = "late" | "close" | null;

export interface Me {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  gmailConnected: boolean;
  lastScanAt: number | null;
  lastScanError: string | null;
  /** Emails that couldn't be read after several tries. */
  failedEmailCount: number;
  scanSince: string;
  deadline: string;
  devMode: boolean;
}

export interface Recipient {
  id: string;
  name: string;
  budgetCents: number | null;
  notes: string | null;
  spentCents: number;
  itemCount: number;
  /** Items that are ordered or further along. */
  boughtCount: number;
}

export interface Shipment {
  id: string;
  orderId: string | null;
  carrier: string | null;
  trackingNumber: string;
  trackingUrl: string | null;
  status: ShipmentStatus;
  estimatedDelivery: string | null;
  deliveredAt: string | null;
}

export interface OrderLine {
  id: string;
  orderId: string;
  description: string;
  quantity: number;
  unitPriceCents: number | null;
  /** Best known cost of this line (unit price x qty, or the order total for single-line orders). */
  amountCents: number | null;
  status: "active" | "cancelled" | "returned";
  shipmentId: string | null;
  /** Linked list item when matched; the suggested item when suggested. */
  itemId: string | null;
  matchState: MatchState;
  matchSource: "ai" | "fuzzy" | "user" | null;
  suggestedRecipientId: string | null;
  shipToName: string | null;
}

export interface Order {
  id: string;
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  totalCents: number | null;
  currency: string;
  status: OrderStatus;
  estimatedDelivery: string | null;
  ignored: boolean;
  source: "email" | "manual";
  emailSubject: string | null;
  /** Something the scanner couldn't sort out, e.g. a cancellation it couldn't match. */
  note: string | null;
  lines: OrderLine[];
  shipments: Shipment[];
}

/** A tracked purchase as seen from the gift it belongs to. */
export interface Purchase {
  lineId: string;
  orderId: string;
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  description: string;
  amountCents: number | null;
  status: ItemStatus;
  eta: string | null;
  shipment: Shipment | null;
}

export interface Item {
  id: string;
  name: string;
  recipientId: string | null;
  notes: string | null;
  url: string | null;
  targetPriceCents: number | null;
  manualStatus: "in_hand" | "wrapped" | null;
  manualPriceCents: number | null;
  status: ItemStatus;
  spentCents: number;
  eta: string | null;
  risk: RiskLevel;
  purchases: Purchase[];
}

export interface MutedVendor {
  vendorKey: string;
  vendor: string;
}

export interface Stats {
  spentCents: number;
  /** Spend on purchases not yet tied to a gift. */
  unsortedCents: number;
  budgetCents: number;
  itemCount: number;
  boughtCount: number;
  inTransitCount: number;
  arrivingThisWeekCount: number;
  needsReviewCount: number;
  atRiskCount: number;
  daysUntilDeadline: number;
}

export interface Dashboard {
  me: Me;
  today: string;
  stats: Stats;
  recipients: Recipient[];
  items: Item[];
  orders: Order[];
  mutedVendors: MutedVendor[];
}

export interface ScanResult {
  processed: number;
  remaining: number;
  found: number;
  errors: string[];
  done: boolean;
}
