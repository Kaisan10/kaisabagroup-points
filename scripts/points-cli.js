#!/usr/bin/env node
require('dotenv').config();
const { pool } = require('../src/config/database');
const User = require('../src/models/User');

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
ポイント管理 CLI ツール

使用法:
  node scripts/points-cli.js <コマンド> [引数]

コマンド:
  info <username>                 ユーザー情報を表示
  rename <old_user> <new_user>    ユーザー名を変更
  move <from> <to> <amount>       ポイントを移動 (承認なし)
  merge <from> <to>               全ポイントを移動してユーザーを統合 (fromのユーザーは残りますが0ptになります)
  ranking-exclude <username>      ランキングからユーザーを除外する (ranking_opt_in = FALSE)
  ranking-include <username>      ランキングにユーザーを参加させる (ranking_opt_in = TRUE)
  help                            このヘルプを表示

  (非推奨) add <username>          ポイントを移動するのではなく直接追加する
  `);
}

async function showInfo(username) {
  if (!username) return console.error('ユーザー名を指定してください');
  const user = await User.findByUsername(username);
  if (!user) return console.error(`ユーザー '${username}' が見つかりません`);
  
  console.log('--- ユーザー情報 ---');
  console.log(`ID: ${user.id}`);
  console.log(`Discourse ID: ${user.discourse_id}`);
  console.log(`ユーザー名: ${user.username}`);
  console.log(`ポイント: ${user.total_points} pt`);
  console.log(`Minecraft ID: ${user.minecraft_id || '未連携'}`);
  console.log(`最終ログイン: ${user.last_login}`);
}

async function renameUser(oldUsername, newUsername) {
  if (!oldUsername || !newUsername) return console.error('旧ユーザー名と新ユーザー名を指定してください');
  const user = await User.findByUsername(oldUsername);
  if (!user) return console.error(`ユーザー '${oldUsername}' が見つかりません`);

  try {
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [newUsername, user.id]);
    console.log(`ユーザー名を変更しました: ${oldUsername} -> ${newUsername}`);
  } catch (err) {
    console.error('変更エラー:', err.message);
  }
}

async function movePoints(fromUsername, toUsername, amount) {
  if (!fromUsername || !toUsername || isNaN(amount)) {
    return console.error('送信元、送信先、およびポイント数を正しく指定してください');
  }

  const fromUser = await User.findByUsername(fromUsername);
  const toUser = await User.findByUsername(toUsername);

  if (!fromUser) return console.error(`送信元ユーザー '${fromUsername}' が見つかりません`);
  if (!toUser) return console.error(`送信先ユーザー '${toUsername}' が見つかりません`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 送信元から減算
    await client.query('UPDATE users SET total_points = total_points - $1 WHERE id = $2', [amount, fromUser.id]);
    // 送信先へ加算
    await client.query('UPDATE users SET total_points = total_points + $1 WHERE id = $2', [amount, toUser.id]);
    
    // トランザクション記録
    await client.query(
      `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
       VALUES ($1, $2, $3, $4)`,
      [fromUser.id, -amount, 'admin_move', `CLIにより ${toUsername} へ移動`]
    );
    await client.query(
      `INSERT INTO point_transactions (user_id, amount, transaction_type, description) 
       VALUES ($1, $2, $3, $4)`,
      [toUser.id, amount, 'admin_move', `CLIにより ${fromUsername} から移動`]
    );

    await client.query('COMMIT');
    console.log(`${amount} pt を ${fromUsername} から ${toUsername} へ移動しました`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('移動エラー:', err.message);
  } finally {
    client.release();
  }
}

async function mergeUsers(fromUsername, toUsername) {
  if (!fromUsername || !toUsername) return console.error('統合元と統合先を指定してください');
  
  const fromUser = await User.findByUsername(fromUsername);
  const toUser = await User.findByUsername(toUsername);

  if (!fromUser) return console.error(`統合元ユーザー '${fromUsername}' が見つかりません`);
  if (!toUser) return console.error(`統合先ユーザー '${toUsername}' が見つかりません`);

  const amount = fromUser.total_points;
  if (amount <= 0) {
    console.log(`${fromUsername} は 0 pt なので、移動するものはありません。`);
    return;
  }

  console.log(`統合中: ${fromUsername} (${amount} pt) -> ${toUsername}`);
  await movePoints(fromUsername, toUsername, amount);
}

async function setRanking(username, optIn) {
  if (!username) return console.error('ユーザー名を指定してください');
  const user = await User.findByUsername(username);
  if (!user) return console.error(`ユーザー '${username}' が見つかりません`);
  await User.setRankingOptIn(user.id, optIn);
  console.log(`${username} のランキング参加を ${optIn ? '有効' : '無効'} にしました (ranking_opt_in = ${optIn})`);
}

async function addCommand(username, amount, flag) {
  if (flag !== '--force') return console.error('非推奨コマンドです。実行するには最後に --force を付けてください。');
  if (!username || !amount) return console.error('ユーザー名とポイント数を指定してください');
  const user = await User.findByUsername(username);
  if (!user) return console.error('ユーザーが見つかりません');
  await User.addPoints(user.id, BigInt(amount), 'admin_add', 'CLI');
  console.log(`${amount} pt を ${username} に付与しました`);
}

async function main() {
  switch (command) {
    case 'info':
      await showInfo(args[1]);
      break;
    case 'rename':
      await renameUser(args[1], args[2]);
      break;
    case 'move':
      await movePoints(args[1], args[2], parseInt(args[3]));
      break;
    case 'merge':
      await mergeUsers(args[1], args[2]);
      break;
    case 'ranking-exclude':
      await setRanking(args[1], false);
      break;
    case 'ranking-include':
      await setRanking(args[1], true);
      break;
    case 'add':
      await addCommand(args[1], args[2], args[3]);
      break;
    case 'help':
    default:
      showHelp();
  }
  await pool.end();
}

main().catch(err => {
  console.error('実行エラー:', err);
  process.exit(1);
});
