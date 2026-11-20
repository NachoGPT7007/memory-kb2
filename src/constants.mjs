// 常量唯一真源。
//
// 为什么集中（2026-11-20 全量 debug 结论）：
//   同一批参数在多个模块里各自写死一份，改一处不生效、显示一处与运行不符。
//   实测分布：
//     去重阈值 0.62   —— 11 处 / 5 个文件
//     web 端口 7999   —— 11 处 / 4 个文件
//     vault 路径      —— 8 处 / 5 个文件（已在 paths.mjs 收敛中）
//     嵌入模型名      —— 2 处
//   新代码一律 import 本文件，不要再写字面量。

/** 向量化 / 重排模型（阿里云百炼）。环境变量仍可覆盖，便于换模型做对照实验。 */
export const EMBED_MODEL = process.env.EMBED_API_MODEL || process.env.EMBED_MODEL || 'qwen3.7-text-embedding'

/** 弱匹配判定阈值：query 向量与全库原子的最大余弦低于它，提示「库里可能没有相关内容」。
 *  标定依据（docs/BENCHMARK.md）：工程库 64 条真实题 min 0.705 / p10 0.742，
 *  5 条无关查询 max 0.523，间隔 0.18，取 0.60。 */
export const WEAK_COS = Number(process.env.MEM_WEAK_COS) || 0.6

/** 索引重建时用于判定「向量缺失过多 → 视为全量重建」的比例。 */
export const VECTOR_FULL_REBUILD_RATIO = 0.5

/** 向量维度（模型固定输出，用于校验 vectors.f32 长度）。 */
export const EMBED_DIM = 1024
