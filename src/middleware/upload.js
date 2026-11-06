import multer from 'multer';
import AppError from '../utils/AppError.js';

// Files are kept in memory for a moment, then streamed to Cloudinary
// by services/uploadService.js. Nothing is saved on the server's disk.

const DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Team materials & attachments: documents, spreadsheets, slides, images
const MATERIAL_TYPES = [
  ...DOCUMENT_TYPES,
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
];

function makeUploader(allowed, maxMb) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new AppError(422, 'This file type is not allowed'));
    },
  });
}

export const uploadDocument = makeUploader(DOCUMENT_TYPES, 10).single('file');
export const uploadImage = makeUploader(IMAGE_TYPES, 5).single('file');
export const uploadMaterial = makeUploader(MATERIAL_TYPES, 20).single('file');
