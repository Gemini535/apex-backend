import { body } from 'express-validator';

export const issueChallenge = [
  body('purpose')
    .isIn(['KEY_ATTESTATION', 'UPLOAD_ASSERTION'])
    .withMessage('purpose must be KEY_ATTESTATION or UPLOAD_ASSERTION'),
];

export const registerKey = [
  body('keyId').isString().notEmpty().withMessage('keyId is required'),
  body('attestationObject').isString().notEmpty().withMessage('attestationObject is required'),
  body('nonce').isString().notEmpty().withMessage('nonce is required'),
];
