import * as brandingModel from '../models/brandingModel.js';
import * as invoiceModel from '../models/invoiceModel.js';
import * as auditModel from '../models/auditModel.js';
import * as userModel from '../models/userModel.js';
import * as organizationModel from '../models/organizationModel.js';
import { uploadFile, deleteFile } from './uploadService.js';
import { cloudinaryEnabled } from '../config/cloudinary.js';
import { sendEmail, invoiceAcceptedEmail } from './emailService.js';
import { env } from '../config/env.js';
import { toDateString } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

// ============================================================
// INVOICE BRANDING — logo, brand colour, the business's signature,
// and customers accepting an invoice (name + drawn signature + note).
// ============================================================

// What the invoice shows (used by the in-app invoice and the public link)
export function brandOf(row) {
  return {
    logoUrl: row?.logo_url || null,
    brandColor: row?.brand_color || null,
    signatureUrl: row?.signature_url || null,
    signatoryName: row?.signatory_name || null,
    signatoryTitle: row?.signatory_title || null,
  };
}

export async function getBranding(orgId) {
  return brandOf(await brandingModel.find(orgId));
}

export async function updateBranding(auth, data) {
  await brandingModel.updateDetails(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'invoice_branding.updated' });
  return getBranding(auth.orgId);
}

// Logo or signature image. Cloudinary when it's set up; in development without it,
// small images are kept in the database instead so you can still try it out.
export async function setImage(auth, kind, file) {
  if (!file) throw new AppError(422, 'Choose an image (PNG, JPG or WebP)');
  const current = await brandingModel.find(auth.orgId);

  let url;
  let publicId = null;
  if (cloudinaryEnabled || env.isProd) {
    const uploaded = await uploadFile(file, { orgId: auth.orgId, subfolder: 'branding' });
    url = uploaded.url;
    publicId = uploaded.publicId;
  } else {
    if (file.size > 300 * 1024) throw new AppError(422, 'Without Cloudinary, keep the image under 300 KB');
    url = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  }

  await brandingModel.setImage(auth.orgId, kind, url, publicId);
  await deleteFile(current?.[`${kind}_public_id`], 'image'); // the old one
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: `invoice_branding.${kind}_changed` });
  return getBranding(auth.orgId);
}

export async function removeImage(auth, kind) {
  const current = await brandingModel.find(auth.orgId);
  await brandingModel.setImage(auth.orgId, kind, null, null);
  await deleteFile(current?.[`${kind}_public_id`], 'image');
  return getBranding(auth.orgId);
}

// ---------- The customer accepts the invoice on the public link ----------
export async function acceptInvoice(token, { name, signature, note }, ip) {
  const invoice = await invoiceModel.findByToken(token, toDateString());
  if (!invoice) throw new AppError(404, 'Invoice not found');

  const added = await brandingModel.accept({
    invoiceId: invoice.id,
    orgId: invoice.organization_id,
    signerName: name,
    signatureData: signature,
    note,
    ip,
  });
  if (!added) throw new AppError(409, 'This invoice has already been accepted');

  await auditModel.log({
    orgId: invoice.organization_id,
    userId: null,
    action: 'invoice.accepted',
    entityType: 'invoice',
    entityId: invoice.id,
    details: `${invoice.invoice_number} by ${name}${note ? `: ${note}` : ''}`,
  });

  // Tell whoever created the invoice
  const creator = invoice.created_by ? await userModel.findById(invoice.created_by) : null;
  if (creator?.email) {
    const organization = await organizationModel.findById(invoice.organization_id);
    try {
      await sendEmail({
        to: creator.email,
        ...invoiceAcceptedEmail({
          firstName: creator.full_name.split(' ')[0],
          businessName: organization.name,
          invoiceNumber: invoice.invoice_number,
          customerName: invoice.customer_name,
          signerName: name,
          note,
          link: `${env.clientUrls[0]}/invoices/${invoice.id}`,
        }),
      });
    } catch (err) {
      console.error('Acceptance email failed:', err.message);
    }
  }
  return acceptanceOf(await brandingModel.findAcceptance(invoice.id));
}

export function acceptanceOf(row) {
  if (!row) return null;
  return { name: row.signer_name, signature: row.signature_data, note: row.note, acceptedAt: row.accepted_at };
}
