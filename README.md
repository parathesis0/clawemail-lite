# ClawMail Lite

一个不依赖 OpenClaw 的 ClawEmail 本地邮箱工具。拿到 ClawEmail 的 auth 链接后，直接配置 `mail-cli`，然后用浏览器像普通邮箱一样收发 `@claw.163.com` 邮件。

## 从零配置

前置条件：

- Node.js 18 或更新版本
- 一个 ClawEmail auth 链接，例如 `t1/xxxx` 或完整的 `https://u.163.com/t1/xxxx`

配置：

```powershell
npm run setup -- --auth-url "t1/xxxx"
```

也可以传完整链接：

```powershell
npm run setup -- --auth-url "https://u.163.com/t1/xxxx"
```

如果拿到的是 Hermes/OpenClaw 页面给出的子邮箱命令，可以把里面的参数直接迁移过来：

```powershell
npm run setup -- --auth-url "t1/xxxx" --home-email "you@example.com"
```

脚本会做这些事：

- 检查 `mail-cli` 是否存在
- 如不存在，执行 `npm i @clawemail/mail-cli -g --force`
- 读取 auth 临时链接里的账号信息
- 写入 `mail-cli` API Key
- 注册邮箱 profile
- 生成可用的 `name@claw.163.com` 邮箱登录配置

注意：auth 链接通常有时效，且可能只能使用一次。配置成功后不需要再保留这个链接。

## 启动邮箱

```powershell
npm start
```

打开终端输出里的地址，默认是：

```text
http://localhost:8787
```

如果 `8787` 被占用，服务会自动尝试后续端口。也可以手动指定端口：

```powershell
$env:PORT=8790; npm start
```

## 验证

```powershell
mail-cli auth test
mail-cli folder list
```

能看到认证成功和文件夹列表，就说明收邮件链路已经可用。

## 自动测试

运行：

```powershell
npm test
```

测试会向 `TEST_TO` 指定的真实邮箱发送一封唯一主题的测试邮件，并向当前 ClawEmail 自己发送一封测试邮件来验证收信、搜索、读信、回复、标记和移动。

改测试收件人：

```powershell
$env:TEST_TO="someone@example.com"; npm test
```

## 功能

- 查看账号状态
- 查看邮箱文件夹
- 查看邮件列表
- 搜索邮件
- 读取邮件正文和头信息
- 发送邮件
- 回复邮件
- 标记已读/未读
- 移动邮件到其他文件夹
- 创建、查看、停用、启用、删除 Agent 子邮箱

创建子邮箱时填写的是子邮箱后缀。例如主邮箱是 `name@claw.163.com`，填写 `test` 后会创建类似 `name.test@claw.163.com` 的子邮箱。

## 附件

发送附件时，在“附件本机路径”输入框里填写本机文件路径。多个附件用 `|` 分隔。

示例：

```text
C:\tmp\a.txt|C:\tmp\b.pdf
```

## 原理

ClawEmail 的 auth 链接返回类似这样的账号数据：

```text
name:accountId:credential
__apikey__:default:apiKey
```

本工具不会安装 OpenClaw，也不会调用 `openclaw plugins install`。它只使用独立的 `@clawemail/mail-cli`：

- `mail-cli auth login` 保存邮箱登录信息
- `mail-cli folder list` 列文件夹
- `mail-cli mail list/search` 列邮件和搜索
- `mail-cli read body/header` 读邮件
- `mail-cli compose send/reply` 发信和回复
- `mail-cli clawemail create/list/info/delete/enable/disable/profile` 管理 Agent 子邮箱
