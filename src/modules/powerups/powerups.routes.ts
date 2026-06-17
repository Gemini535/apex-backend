import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import {
  spinWheelHandler,
  getPowerUpsHandler,
  activatePowerUpHandler,
  getCosmeticsHandler,
  equipCosmeticHandler,
  createContractHandler,
  getContractsHandler,
  cancelContractHandler,
} from './powerups.controller.js';

const router = Router();

// ─── Token Wheel ──────────────────────────────────────────────────────────────
router.post('/wheel/spin', authenticateToken, spinWheelHandler);

// ─── Power-Ups ────────────────────────────────────────────────────────────────
router.get('/power-ups', authenticateToken, getPowerUpsHandler);
router.post('/power-ups/activate', authenticateToken, activatePowerUpHandler);

// ─── Cosmetics (Cortex Vault) ─────────────────────────────────────────────────
router.get('/cosmetics', authenticateToken, getCosmeticsHandler);
router.post('/cosmetics/equip', authenticateToken, equipCosmeticHandler);

// ─── Commitment Contracts ─────────────────────────────────────────────────────
router.post('/commitments', authenticateToken, createContractHandler);
router.get('/commitments', authenticateToken, getContractsHandler);
router.post('/commitments/:contractId/cancel', authenticateToken, cancelContractHandler);

export default router;
