import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import {
  registerDevice,
  listDevices,
  unregisterDevice,
} from './devices.service.js';

export async function registerDeviceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, platform } = req.body as {
      token: string;
      platform?: string;
    };

    if (!token) {
      throw new AppError('token is required', 400);
    }

    const device = await registerDevice(req.user!.userId, token, platform ?? 'ios');
    res.status(201).json({ message: 'Device registered.', device });
  } catch (err) {
    next(err);
  }
}

export async function listDevicesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const devices = await listDevices(req.user!.userId);
    res.json({ devices });
  } catch (err) {
    next(err);
  }
}

export async function unregisterDeviceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.params;
    if (!token) {
      throw new AppError('token is required', 400);
    }

    await unregisterDevice(req.user!.userId, token);
    res.json({ message: 'Device unregistered.' });
  } catch (err) {
    next(err);
  }
}

export async function updateDeviceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.body as { token: string };
    if (!token) {
      throw new AppError('token is required', 400);
    }

    // Re-register with a new token (e.g. after app reinstall).
    const device = await registerDevice(req.user!.userId, token, req.body.platform ?? 'ios');
    res.json({ message: 'Device updated.', device });
  } catch (err) {
    next(err);
  }
}
