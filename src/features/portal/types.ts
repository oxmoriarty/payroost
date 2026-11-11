import type { ChangeRequest } from "@/features/projects/types";

export interface PortalMilestone {
  id: string;
  title: string;
  description: string;
  deliverables: string[];
  amountMinor: number;
  currency: string;
  dueDate: string | null;
  sortOrder: number;
  status: string;
  isPayable: boolean;
  paymentStatus: "PAID" | "PENDING_VERIFICATION" | "IN_PROGRESS" | "UNPAID";
  paymentIntentId?: string | null;
  providerOrderId?: string | null;
  completedCaptureId?: string | null;
}

export interface PortalProjectData {
  id: string;
  title: string;
  clientName: string;
  clientEmail: string;
  brief: string;
  currency: string;
  totalAmountMinor: number;
  projectStatus: string;
  agreementStatus: string;
  agreementVersionId?: string | null;
  agreementVersionNumber?: number;
  scopeBaselineVersionNumber?: number | null;
  scopeBaselineStatus?: string | null;
  canUseAi?: boolean;
  changeRequests?: ChangeRequest[];
  milestones: PortalMilestone[];
}

export interface PortalInvitationMetadata {
  valid: boolean;
  projectTitle: string;
  expiresAt: string;
}

export interface PortalPaymentReturnContext {
  paymentIntentId: string;
  paymentStatus: "approved" | "cancelled";
  orderToken?: string | null;
}
