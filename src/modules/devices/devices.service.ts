/**
 * Device registration service.
 *
 * Stores APNs device tokens so the backend can send push notifications to a
 * user's iOS devices. One user may register multiple devices (phone, tablet).
 * The token is unique — re-registering the same token updates the row rather
 * than creating a duplicate.
 */

import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';

export interface DeviceRegistration {
  token: string;
  platform?: string;
}

export async function registerDevice(
  userId: string,
  token: string,
  platform = 'ios',
): Promise<{ id: string; token: string; platform: string }> {
  if (!token || token.length < 10) {
    throw new AppError('A valid device token is required', 400);
  }

  // Upsert on the unique token. If another user previously owned this token
  // (e.g. they logged out and a new user logged in on the same device), the
  // userId is updated to the new owner.
  const device = await prisma.device.upsert({
    where: { token },
    create: { userId, token, platform },
    update: { userId, platform },
  });

  return { id: device.id, token: device.token, platform: device.platform };
}

export async function listDevices(userId: string) {
  return prisma.device.findMany({
    where: { userId },
    select: { id: true, token: true, platform: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function unregisterDevice(
  userId: string,
  token: string,
): Promise<void> {
  // Only delete if the device belongs to this user.
  const device = await prisma.device.findUnique({ where: { token } });
  if (!device || device.userId !== userId) {
    throw new AppError('Device not found', 404);
  }

  await prisma.device.delete({ where: { token } });
}

/** Returns the device tokens for a user (used by push notification service). */
export async function getDeviceTokens(userId: string): Promise<string[]> {
  const devices = await prisma.device.findMany({
    where: { userId },
    select: { token: true },
  });
  return devices.map((d) => d.token);
}
