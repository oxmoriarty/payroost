import type { AgreementContentLike } from "@/features/agreements/agreement-document-view";
import type { ChangeRequest } from "@/features/projects/types";

export interface PortalMilestone {
  id: string;
  title: string;
  description: string;
  deliverables: string[];
  acceptanceCriteria?: string[];
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
  latestSubmissionNote?: string | null;
  latestDeliverableUrl?: string | null;
  latestFeedbackNote?: string | null;
}

export interface PortalAgreementVersionSummary {
  id: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  content: AgreementContentLike | null;
}

export interface PortalActivityItem {
  id: string;
  actorLabel: string;
  eventType: string;
  summary: string;
  createdAt: string;
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
  startDate?: string | null;
  targetEndDate?: string | null;
  agreementStatus: string;
  agreementVersionId?: string | null;
  agreementVersionNumber?: number;
  scopeBaselineVersionNumber?: number | null;
  scopeBaselineStatus?: string | null;
  agreementContent?: AgreementContentLike | null;
  agreementApprovedAt?: string | null;
  agreementVersionHistory?: PortalAgreementVersionSummary[];
  canUseAi?: boolean;
  changeRequests?: ChangeRequest[];
  activities?: PortalActivityItem[];
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
