#!/usr/bin/env node
/**
 * minecraft-mock.js — Minecraft サーバーモック（開発環境用）
 *
 * 実際のマイクラサーバー（プラグイン）の代わりに、
 * ポイントシステムの Minecraft API エンドポイントを叩くツール。
 *
 * 使い方:
 *   node tools/minecraft-mock.js [ポイントサーバーのURL] [APIキー]
 *
 * 例:
 *   node tools/minecraft-mock.js http://localhost:4001 <API_KEY>
 *
 * ※ 引数を省略した場合は .env から自動読み込み
 */

'use strict';

require('dotenv').config();
const readline = require('readline');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── 設定 ────────────────────────────────────────────────────────────────────

const BASE_URL   = process.argv[2] || 'http://localhost:4001';
const MC_API_KEY = process.argv[3] || process.env.MINECRAFT_API_KEY || '';

if (!MC_API_KEY) {
  console.error('❌ MINECRAFT_API_KEY が設定されていません。');
  console.error('   .env に MINECRAFT_API_KEY を設定するか、引数で渡してください。');
  process.exit(1);
}

// ─── HTTP クライアント ────────────────────────────────────────────────────────

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'x-api-key': MC_API_KEY,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: { raw } });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── カラー出力 ───────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
};

function printResult(res) {
  const httpOk     = res.status < 400;
  const successOk  = res.data?.success !== false;
  const icon  = httpOk ? (successOk ? '✅' : '⚠️ ') : '❌';
  const color = httpOk ? (successOk ? C.green : C.yellow) : C.red;
  const label = httpOk ? (successOk ? '成功' : '業務エラー') : 'HTTPエラー';
  console.log(`\n${icon} HTTP ${res.status} (${label})`);
  console.log(color + JSON.stringify(res.data, null, 2) + C.reset);
}

// ─── コマンド定義 ─────────────────────────────────────────────────────────────

const COMMANDS = {
  async points(args) {
    if (!args[0]) {
      console.log(`${C.yellow}使い方: points <discourseユーザー名>${C.reset}`);
      console.log(`${C.yellow}     または: points mc:<マイクラID>${C.reset}`);
      return;
    }
    let path;
    if (args[0].startsWith('mc:')) {
      const mcId = args[0].slice(3);
      path = `/api/minecraft/points?mc_id=${encodeURIComponent(mcId)}`;
    } else {
      path = `/api/minecraft/points?username=${encodeURIComponent(args[0])}`;
    }
    console.log(`${C.cyan}▶ GET ${path}${C.reset}`);
    const res = await request('GET', path);
    printResult(res);
  },

  async link(args) {
    if (args.length < 2) {
      console.log(`${C.yellow}使い方: link <トークン> <マイクラID>${C.reset}`);
      console.log(`${C.yellow}例:     link ABC123 Steve${C.reset}`);
      return;
    }
    const [token, mcId] = args;
    const path = '/api/minecraft/link';
    const body = { token, minecraft_username: mcId };
    console.log(`${C.cyan}▶ POST ${path}${C.reset}`);
    console.log(`${C.gray}  body: ${JSON.stringify(body)}${C.reset}`);
    const res = await request('POST', path, body);
    printResult(res);
  },

  async mcpoints(args) {
    if (!args[0]) {
      console.log(`${C.yellow}使い方: mcpoints <マイクラID>${C.reset}`);
      return;
    }
    const path = `/api/minecraft/points?mc_id=${encodeURIComponent(args[0])}`;
    console.log(`${C.cyan}▶ GET ${path}${C.reset}`);
    const res = await request('GET', path);
    printResult(res);
  },

  async ping(_args) {
    console.log(`${C.cyan}▶ 接続テスト中... ${BASE_URL}${C.reset}`);
    try {
      const res = await request('GET', '/api/minecraft/points?username=__ping_test__');
      if (res.status === 401) {
        console.log(`${C.red}❌ APIキーが無効です (401)${C.reset}`);
      } else if (res.status === 500) {
        console.log(`${C.red}❌ サーバーエラー (500)${C.reset}`);
      } else {
        console.log(`${C.green}✅ サーバーに接続できました (HTTP ${res.status})${C.reset}`);
      }
    } catch (err) {
      console.log(`${C.red}❌ 接続失敗: ${err.message}${C.reset}`);
      console.log(`${C.gray}   サーバーが起動していますか？ (${BASE_URL})${C.reset}`);
    }
  },

  help(_args) {
    console.log(`
${C.bold}${C.blue}=== Minecraft サーバーモック コマンド一覧 ===${C.reset}

  ${C.green}points <ユーザー名>${C.reset}
      Discourseユーザー名でポイントを照会する
      例: points bac0n

  ${C.green}points mc:<マイクラID>${C.reset}
      マイクラIDでポイントを照会する
      例: points mc:Steve

  ${C.green}mcpoints <マイクラID>${C.reset}
      マイクラIDでポイントを照会する（上と同じ）

  ${C.green}link <トークン> <マイクラID>${C.reset}
      マイクラで /pt link を実行したときのシミュレーション
      Webで発行したトークンを使ってマイクラIDを連携させる
      例: link ABC123 Steve

  ${C.green}ping${C.reset}
      サーバーへの接続とAPIキーを確認する

  ${C.green}help${C.reset}
      このヘルプを表示する

  ${C.green}exit / quit${C.reset}
      終了する

${C.gray}接続先: ${BASE_URL}${C.reset}
${C.gray}APIキー: ${MC_API_KEY.slice(0, 8)}...${C.reset}
`);
  },
};

// ─── REPL ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}${C.blue}╔══════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.blue}║  🎮 Minecraft サーバーモック (開発環境用)    ║${C.reset}`);
  console.log(`${C.bold}${C.blue}╚══════════════════════════════════════════════╝${C.reset}`);
  console.log(`${C.gray}接続先: ${BASE_URL}${C.reset}`);
  console.log(`${C.gray}APIキー: ${MC_API_KEY.slice(0, 8)}...${C.reset}`);
  console.log(`${C.gray}help でコマンド一覧を表示します${C.reset}\n`);

  await COMMANDS.ping([]);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.cyan}mc-mock> ${C.reset}`,
    terminal: true,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/).filter(Boolean);
    if (!cmd) {
      rl.prompt();
      return;
    }

    if (cmd === 'exit' || cmd === 'quit') {
      console.log(`${C.gray}bye!${C.reset}`);
      rl.close();
      process.exit(0);
    }

    if (COMMANDS[cmd]) {
      try {
        await COMMANDS[cmd](args);
      } catch (err) {
        console.log(`${C.red}❌ エラー: ${err.message}${C.reset}`);
      }
    } else {
      console.log(`${C.yellow}不明なコマンド: ${cmd}  (help で一覧表示)${C.reset}`);
    }

    console.log('');
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main();
