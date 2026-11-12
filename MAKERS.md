# 书店小管家 Makers 版

EdgeOne Makers 在构建时执行 npm run build，将工作台写入 dist，并打包 agents/bookshop/index.ts。界面操作及对话使用 /bookshop，由 makers-conversation-id 将请求路由到同一访客会话。

在线教学演示使用同一份样例书目作为初始数据。每个浏览器会话都有独立的 SQLite 数据，服务器完成校验和事务后将结果保存到 Makers 会话存储。可以刷新后查看自己的模拟订单。同一预览重复确认会返回原订单。清理站点数据会生成新的演示会话。

在线演示由页面快捷操作触发，使用样例数据。启用模型问答需要为项目配置 BOOKSHOP_MODEL，并由平台注入 AI_GATEWAY_API_KEY 和 AI_GATEWAY_BASE_URL。真实模型会占用对应平台额度。原项目的 Agnes 密钥与本地数据库未复制到此目录。

验证路径为先查 B001，再预览 2 本，核对总额 90 元与预览前库存 10 本。确认后库存为 8 本，可在订单中心查到一笔订单。重复确认返回同一订单。新浏览器会话从样例库存 10 本开始。

本地 node 服务保留原有启动命令 npm ci 和 npm start，使用 Node.js 24 或更高版本。运行 npm test 可验证原有业务、模型协议和 HTTP 接口。
