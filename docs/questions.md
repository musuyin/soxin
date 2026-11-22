# Open design questions

Write your answer beneath each question. These decisions affect the first implementation.

### Implementation language

Should the service use TypeScript and Node.js to reuse the Discord bridge directly, or do you prefer another stack?

Answer: TypeScript is good.

设计要求：

整体采用现代日系极简风格。

以黑、白、灰为主要配色，薄荷绿作为少量强调色。

使用充足的留白、清晰的视觉层级和统一的间距。

使用细腻的边框、柔和的阴影和适度圆角。

优先保证排版、字体与色彩的一致性。

使用 Motion 添加轻微的悬停和过渡动画。

支持深色模式和移动端响应式布局。

避免过度使用渐变、玻璃拟态和复杂动画。

使用共享设计变量，避免每个组件分别定义样式。

保持组件可复用，并符合基本的无障碍要求。

### Memory model

Which provider and invocation method should the first memory adapter support for retrieval, text extraction, and meal photos?

Answer: Codex CLI in local. High level model uses GPT6.2 Sol High. Low level model uses GPT6 Luna High

### Session controls

Should Discord allow users to change the configured model?

Answer: I think this function is not fit to our goal so we should remove it. Also remove it from our documents.

### Meal date

If you report yesterday's dinner today, should Diet store the meal date separately from the creation timestamp?

Answer: Yes, the creation timestamp don't need to be the same as date.

### Finance records

Should income and expenses use separate tables? Should each monthly total be per currency, with integer amounts in minor units (for example, 1250 for CNY 12.50)? Should details be plain text or structured line items?

Answer: I think it is best to use separate tables. But we can show them in the same window and two different blocks in the dashboard. The amounts should be shown as 12.50. Details can be stored as json but when they are shown, we can create a table for a better view.

### Memory lifecycle

What should installing and uninstalling memory do from the user's perspective? For example, should a domain be removable from retrieval while its records remain on disk?

Answer: No, all the memory should keep in the database. The installing is means loading the retrieved memory into user's input. And the uninstalling is don't load those memory into input (Sounds like do nothing).
