/**
 * 站点适配器注册表
 *
 * 新增站点只需要：
 * 1. 写一个 adapter（实现 match / ready / collectTurns / listSessions / openSession ...）
 * 2. 在这里加进 ADAPTERS
 * 3. manifest 的 content_scripts.matches 加上域名
 *
 * @file src/adapters/index.js
 */

import { deepseekAdapter } from './deepseek.js';
import { dshAdapter } from './dsh.js';

export const ADAPTERS = [deepseekAdapter, dshAdapter];

/**
 * 找出当前页面适用的适配器。
 * match 内部可能访问 DOM（DSH 需要判断是不是它自己的界面），所以要 try 包住。
 */
export function resolveAdapter(loc = location) {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match(loc)) return adapter;
    } catch (e) {
      // 匹配失败等同于不匹配
    }
  }
  return null;
}

export { deepseekAdapter, dshAdapter };
