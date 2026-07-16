# Surge — Adobe Telemetry Block

在应用层用 Surge 屏蔽 Adobe 遥测 / 正版校验（Genuine Service）域名，替代 `hosts` 方案。
**不修改 `/etc/hosts`、不需要 root、没有后台守护进程。**

数据来源：[`a-dove-is-dumb`](https://github.com/ignaciocastro/a-dove-is-dumb)（`https://a.dove.isdumb.one/list.txt`），已转换为 Surge 规则。整份列表 4333 个域名坍缩为 **2 条稳定后缀（覆盖 98.2%）+ 80 条具体主机**。

## 远程导入（Surge Mac）

Surge Mac 只支持通过 URL 远程导入模块。打开 **Surge → 模块（Modules） → 从 URL 安装**，粘贴：

```
https://raw.githubusercontent.com/SkyBlue997/Surge/main/Adobe-Telemetry-Block.sgmodule
```

装好后打开开关即可。模块自包含全部规则，无外部依赖。

## 方式二：DOMAIN-SET（写进主配置 `[Rule]`）

```
DOMAIN-SET,https://raw.githubusercontent.com/SkyBlue997/Surge/main/adobe-block.dset,REJECT
```

保存后 `surge-cli reload`。Surge 会把它作为外部资源按周期自动刷新；手动刷新：

```
surge-cli external-resource update all
```

## 生效条件

- Surge 需处于 **规则模式（Rule）** 且系统代理开启，Adobe 流量才会命中规则。
- 个别 Adobe 组件可能绕过系统代理直连；需要时开启 Surge **增强模式（Enhanced Mode）** 兜底。

## 验证

```bash
CLI=/Applications/Surge.app/Contents/Applications/surge-cli
$CLI dump rule | grep -iE 'adobestats|hstatic'   # 规则已加载
$CLI watch request                               # 打开 Lightroom，看遥测请求是否 REJECT
```

## 更新

- 两条后缀（`adobestats.io`、`hstatic.io`）稳定，长期不用动。
- 具体的 `*.adobe.io` 主机会在上游轮换，隔一段时间用下方脚本重新生成并 push 即可。

```bash
curl -sS https://a.dove.isdumb.one/list.txt \
  | awk '$1=="0.0.0.0"{print $2}' \
  | grep -vE '(^|\.)(adobestats\.io|hstatic\.io)$' \
  | sort -u > explicit_hosts.txt
# 用 explicit_hosts.txt 重建 .sgmodule 的 DOMAIN 行与 .dset
```

## 说明

仅屏蔽遥测 / 正版校验回连，按上游说明不影响正常登录、下载、AI 生成等功能。REJECT 为即时拒绝，避免应用等待超时。
