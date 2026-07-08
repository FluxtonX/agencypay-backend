import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PaymentsService } from './payments.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Public() // Enable public access or rely on global guard if user tokens are passed
@Controller('payments')
export class ExcelController {
  private readonly logger = new Logger(ExcelController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('excel/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  async uploadExcel(
    @UploadedFile() file: Express.Multer.File,
    @Body('walletId') walletId: string,
  ) {
    if (!file) {
      throw new BadRequestException('Excel/CSV file is required in multipart field "file"');
    }
    if (!walletId) {
      throw new BadRequestException('walletId is required to associate payments');
    }

    this.logger.log(`Received file upload proxy request: ${file.originalname} (${file.size} bytes) for wallet: ${walletId}`);

    try {
      // 1. Construct FormData to forward to the Render backend service
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
      formData.append('file', blob, file.originalname);

      // 2. Call external API to upload the file
      this.logger.log('Uploading file to external parsing service...');
      const uploadRes = await fetch('https://agencypay-website-backend.onrender.com/api/excel/uploads', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        this.logger.error(`External upload failed with status ${uploadRes.status}: ${errText}`);
        let errBody;
        try {
          errBody = JSON.parse(errText);
        } catch {
          errBody = null;
        }
        throw new BadRequestException(errBody?.error?.message || errBody?.message || 'External parsing service upload failed');
      }

      const uploadData: any = await uploadRes.json();
      if (!uploadData?.success || !uploadData?.data?.uploadId) {
        throw new BadRequestException('Invalid response from external parsing service');
      }

      const uploadId = uploadData.data.uploadId;
      this.logger.log(`External upload succeeded. Assigned Upload ID: ${uploadId}`);

      // 3. Call external API to get parsed summary
      this.logger.log(`Fetching summary for Upload ID: ${uploadId}`);
      const summaryRes = await fetch(`https://agencypay-website-backend.onrender.com/api/excel/uploads/${uploadId}/summary`);
      
      if (!summaryRes.ok) {
        throw new BadRequestException('Failed to fetch summary from external parsing service');
      }

      const summaryData: any = await summaryRes.json();
      if (!summaryData?.success || !summaryData?.data?.vendors) {
        throw new BadRequestException('Invalid summary response from external parsing service');
      }

      const vendors = summaryData.data.vendors; // Array of { vendor: string, totalNetIncome: number, ... }
      this.logger.log(`Extracted ${vendors.length} vendors from Excel sheet`);

      // 4. Save parsed items to PostgreSQL database via PaymentsService
      const savedPayments: any[] = [];
      for (const v of vendors) {
        // Construct a unique externalId to prevent double ingestion
        const vendorKey = v.vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
        const externalId = `${uploadId}-${vendorKey}`;

        this.logger.log(`Ingesting payment for ${v.vendor}: $${v.totalNetIncome}`);

        try {
          const payment = await this.paymentsService.ingestPayment({
            externalId,
            source: 'MANUAL',
            walletId: walletId,
            amount: v.totalNetIncome.toString(),
            currency: 'USD',
            description: `Digital Sales Ingestion: ${v.vendor}`,
            metadata: {
              vendor: v.vendor,
              uploadId: uploadId,
              fileName: file.originalname,
              rowCount: v.rowCount,
              totalDistribution: v.totalDistribution,
              totalNetPayable: v.totalNetPayable,
              totalReturns: v.totalReturns,
            },
          });
          savedPayments.push(payment);
        } catch (dbErr: any) {
          this.logger.error(`Failed to ingest payment for vendor ${v.vendor} to DB: ${dbErr.message}`);
          // Continue ingesting other vendors, or throw
        }
      }

      return {
        success: true,
        data: {
          uploadId,
          fileName: file.originalname,
          vendorsCount: vendors.length,
          payments: savedPayments,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error in uploadExcel handler: ${error.message}`);
      throw error instanceof BadRequestException ? error : new BadRequestException(error.message || 'Error occurred during file ingestion');
    }
  }
}
