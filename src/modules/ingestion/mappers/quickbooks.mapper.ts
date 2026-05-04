import { Injectable } from '@nestjs/common';
import type { NormalizedInvoice } from '../../../integrations/quickbooks/quickbooks.service.js';
import type { InvoiceStatus } from '@prisma/client';

@Injectable()
export class QuickBooksMapper {
  /**
   * Maps a normalized QuickBooks invoice to our internal Invoice schema.
   */
  mapToInternalInvoice(qbInvoice: NormalizedInvoice, walletId: string) {
    return {
      walletId,
      externalId: qbInvoice.externalId,
      invoiceNumber: qbInvoice.invoiceNumber,
      amount: qbInvoice.amount,
      currency: qbInvoice.currency || 'USD',
      status: this.mapStatus(qbInvoice.status),
      dueDate: qbInvoice.dueDate ? new Date(qbInvoice.dueDate) : null,
      metadata: {
        ...qbInvoice.metadata,
        customerName: qbInvoice.customerName,
        customerId: qbInvoice.customerId,
      },
      lineItems: {
        create: qbInvoice.lineItems.map((item) => ({
          description: item.description,
          amount: item.amount,
          quantity: item.quantity,
        })),
      },
    };
  }

  private mapStatus(qbStatus: string): InvoiceStatus {
    const status = qbStatus.toLowerCase();
    if (status === 'paid') return 'PAID';
    if (status === 'void') return 'VOID';
    if (status === 'uncollectible') return 'UNCOLLECTIBLE';
    if (status === 'draft') return 'DRAFT';
    return 'OPEN';
  }
}
