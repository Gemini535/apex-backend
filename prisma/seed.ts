import { PrismaClient, BrainTier } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clean existing data
  await prisma.poolLedger.deleteMany();
  await prisma.poolParticipant.deleteMany();
  await prisma.pool.deleteMany();
  await prisma.tokenTransaction.deleteMany();
  await prisma.tokenWallet.deleteMany();
  await prisma.screenTimeEntry.deleteMany();
  await prisma.brainState.deleteMany();
  await prisma.blockedUser.deleteMany();
  await prisma.friendRequest.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.session.deleteMany();
  await prisma.twoFactorSetting.deleteMany();
  await prisma.paymentAccount.deleteMany();
  await prisma.user.deleteMany();

  // Create test users
  const passwordHash = await bcrypt.hash('TestPassword1!', 12);

  const alice = await prisma.user.create({
    data: {
      email: 'alice@apex.app',
      username: 'alice',
      passwordHash,
      displayName: 'Alice',
      brainHealth: 95,
      brainTier: BrainTier.PRISTINE,
      currentStreak: 14,
      longestStreak: 30,
    },
  });

  const bob = await prisma.user.create({
    data: {
      email: 'bob@apex.app',
      username: 'bob',
      passwordHash,
      displayName: 'Bob',
      brainHealth: 45,
      brainTier: BrainTier.SLIME,
      currentStreak: 3,
      longestStreak: 7,
    },
  });

  const charlie = await prisma.user.create({
    data: {
      email: 'charlie@apex.app',
      username: 'charlie',
      passwordHash,
      displayName: 'Charlie',
      brainHealth: 72,
      brainTier: BrainTier.FOG,
      currentStreak: 7,
      longestStreak: 15,
    },
  });

  // Create token wallets for each user
  await prisma.tokenWallet.createMany({
    data: [
      { userId: alice.id, balance: 150 },
      { userId: bob.id, balance: 75 },
      { userId: charlie.id, balance: 200 },
    ],
  });

  // Create friendships
  await prisma.friendship.create({
    data: { userId: alice.id, friendId: bob.id },
  });
  await prisma.friendship.create({
    data: { userId: bob.id, friendId: charlie.id },
  });

  // Create 2FA settings
  await prisma.twoFactorSetting.createMany({
    data: [
      { userId: alice.id },
      { userId: bob.id },
      { userId: charlie.id },
    ],
  });

  // Create sample screen time entries for today
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.screenTimeEntry.createMany({
    data: [
      {
        userId: alice.id,
        appName: 'Instagram',
        appBundleId: 'com.burbn.instagram',
        category: 'SOCIAL',
        duration: 1800, // 30 min
        startedAt: new Date(today.getTime() + 9 * 3600000),
        endedAt: new Date(today.getTime() + 9.5 * 3600000),
        isBlacklisted: true,
      },
      {
        userId: alice.id,
        appName: 'Safari',
        appBundleId: 'com.apple.mobilesafari',
        category: 'PRODUCTIVITY',
        duration: 3600, // 1 hour
        startedAt: new Date(today.getTime() + 10 * 3600000),
        endedAt: new Date(today.getTime() + 11 * 3600000),
      },
      {
        userId: bob.id,
        appName: 'TikTok',
        appBundleId: 'com.zhiliaoapp.musically',
        category: 'SOCIAL',
        duration: 7200, // 2 hours
        startedAt: new Date(today.getTime() + 8 * 3600000),
        endedAt: new Date(today.getTime() + 10 * 3600000),
        isBlacklisted: true,
      },
      {
        userId: bob.id,
        appName: 'Clash Royale',
        appBundleId: 'com.supercell.clashroyale',
        category: 'GAMES',
        duration: 5400, // 1.5 hours
        startedAt: new Date(today.getTime() + 14 * 3600000),
        endedAt: new Date(today.getTime() + 15.5 * 3600000),
        isBlacklisted: true,
      },
    ],
  });

  console.log(`✅ Seeded 3 users (alice, bob, charlie)`);
  console.log(`   Password for all: TestPassword1!`);
  console.log(`   Friendships: Alice↔Bob, Bob↔Charlie`);
  console.log(`   Token wallets: Alice=150, Bob=75, Charlie=200`);
  console.log(`   Sample screen time entries created for today`);
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
