import * as documentModel from '../models/documentModel.js';
import * as auditModel from '../models/auditModel.js';
import { getEmployeeOrFail } from './accessService.js';
import { uploadFile, deleteFile } from './uploadService.js';
import AppError from '../utils/AppError.js';

// Employees can always see their own documents
export async function listDocuments(auth, employeeId) {
  await getEmployeeOrFail(auth, 'documents.view', employeeId, { allowSelf: true });
  return documentModel.listByEmployee(auth.orgId, employeeId);
}

export async function uploadDocument(auth, employeeId, file, { title, category }) {
  if (!file) throw new AppError(422, 'Choose a file to upload', { file: 'Choose a file' });
  const employee = await getEmployeeOrFail(auth, 'documents.manage', employeeId);

  const uploaded = await uploadFile(file, { orgId: auth.orgId, subfolder: 'documents' });
  const id = await documentModel.create(auth.orgId, {
    employeeId: employee.id,
    title: title || file.originalname,
    category,
    fileUrl: uploaded.url,
    publicId: uploaded.publicId,
    resourceType: uploaded.resourceType,
    fileName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    uploadedBy: auth.userId,
  });

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'document.uploaded',
    entityType: 'employee',
    entityId: employee.id,
    details: title,
  });
  return documentModel.findById(auth.orgId, id);
}

export async function deleteDocument(auth, documentId) {
  const doc = await documentModel.findById(auth.orgId, documentId);
  if (!doc) throw new AppError(404, 'Document not found');
  await getEmployeeOrFail(auth, 'documents.manage', doc.employee_id);

  await documentModel.remove(auth.orgId, documentId);
  await deleteFile(doc.public_id, doc.resource_type);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'document.deleted',
    entityType: 'employee',
    entityId: doc.employee_id,
    details: doc.title,
  });
}
