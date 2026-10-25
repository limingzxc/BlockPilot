/**
 * 所有出站请求统一用的 User-Agent。
 *
 * 规则来自 BMCLAPI 维护者本人在 MCLF-CN/docs#2 提出的约定：
 * 以 `${NAME}/${VERSION}` 开头，例如 `BMCLNG/4.10.0.1234`。
 * 之后的附加信息暂不作要求，但建议带上可联系的项目地址。
 *
 * MCIM 使用前需要在 mcmod-info-mirror/mcim-rust-api issue #12 登记启动器信息，
 * 登记的就是这里的前缀。改名前先改登记，否则可能被白名单挡掉。
 */
export const USER_AGENT = 'BlockPilot/0.0.1'
