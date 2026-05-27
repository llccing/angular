如果你要**操作 DOM**，**优先放在 render callbacks 里**，而不是普通 `effect()`、`ngAfterViewInit()`、`ngAfterViewChecked()` 里。Angular 官方文档明确建议：直接 DOM 操作应尽量避免；如果必须做，应该使用 `afterNextRender` / `afterEveryRender`，并且**不要在其他生命周期钩子里直接操作 DOM**，因为 Angular 只在 render callbacks 时保证 DOM 已完成渲染。Render callbacks 需要在 injection context 中注册，通常是在组件构造函数里。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

更具体地说，**信号驱动场景下**：
- **一次性、首屏后的 DOM 初始化**：用 `afterNextRender`
- **每次渲染后都要根据 signal 结果同步 DOM / 第三方控件**：用 `afterRenderEffect`
- **纯状态派生**：继续用 `computed`
- **同步非 DOM 的命令式 API**：可以用普通 `effect`
Angular 官方对 `afterRenderEffect` 的定位很明确：它像 `effect` 一样跟踪 signal 依赖，但**在 Angular 完成 DOM 提交之后才运行**，适合需要直接检查/修改 DOM 或对接第三方 UI/图表库的场景。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

## 推荐的最佳实践

### 1. 能用模板绑定，就不要手写 DOM
这是第一原则。官方文档明确说：**始终优先通过模板和绑定表达 DOM 结构与更新**，只有模板表达不了的行为，才去直接操作 DOM。比如：
- class / style / attribute 更新 → 模板绑定
- 条件显示 / 列表更新 → 模板控制流
- 输入值展示 → 插值/绑定
而像下面这些才更适合 DOM API：
- `focus()`
- 读元素尺寸 / 位置
- `scrollIntoView()`
- 绑定第三方图表、地图、编辑器
- Canvas/SVG 自定义绘制  
([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

### 2. 一次性初始化 DOM：`afterNextRender`
比如初始化图表、测量初始尺寸、首次 focus。官方生命周期文档说明 `afterNextRender` 会在**下一次 Angular 完成整页渲染后**执行，而且**不会在 SSR / 预渲染时运行**。这也意味着它很适合浏览器专属 DOM 初始化。([next.angular.dev](https://next.angular.dev/guide/components/lifecycle?utm_source=openai))

示例：

```ts
import {
  Component,
  ElementRef,
  afterNextRender,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-search-box',
  template: `<input #input />`,
})
export class SearchBoxComponent {
  input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  constructor() {
    afterNextRender({
      write: () => {
        this.input().nativeElement.focus();
      },
    });
  }
}
```

这个模式比 `ngAfterViewInit` 更符合现在 Angular 的官方建议，因为官方明确说**不要在其他生命周期钩子里直接操作 DOM**。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

### 3. 随 signal 变化更新 DOM：`afterRenderEffect`
Angular 官方 signals 文档给的典型例子，就是：
- 用 `afterNextRender` 创建图表实例
- 用 `afterRenderEffect` 在 signal 数据变化且 DOM 已提交后更新图表  
这几乎就是官方推荐模板。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

对应模式：

```ts
import {
  Component,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  input,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-chart',
  template: `<canvas #canvas></canvas>`,
})
export class ChartComponent {
  data = input.required<number[]>();
  canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private chart!: ChartInstance;

  constructor() {
    afterNextRender({
      write: () => {
        this.chart = initializeChart(this.canvas().nativeElement, this.data());
      },
    });

    afterRenderEffect({
      write: () => {
        this.chart.updateData(this.data());
      },
    });
  }
}
```

这类场景下，**不要用普通 `effect()` 直接改 DOM**，因为官方说明普通 `effect` 是在变更检测过程中异步执行，但**在 Angular 更新 DOM 之前**，而 `afterRenderEffect` 才是 DOM 提交之后。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 4. 分离 read / write，避免 layout thrashing
如果你的 DOM 操作既要读布局又要写布局，Angular 官方建议利用 render phases，把逻辑拆成：
- `earlyRead`
- `write`
- `mixedReadWrite`
- `read`

官方特别强调：**如果不指定 phase，`afterRenderEffect` 默认运行在 `mixedReadWrite`，这可能更差**；应尽量把读写拆开，减少重排抖动。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

例如：

```ts
afterRenderEffect({
  earlyRead: () => {
    return this.panel().nativeElement.getBoundingClientRect().width;
  },
  write: (width) => {
    this.panel().nativeElement.style.height = `${width()}px`;
  },
});
```

如果只是写，不要读；如果只是读，不要写。  
这和浏览器性能最佳实践一致，Angular 把它内建成了 API 约束。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 5. 优先用观察器，而不是反复 effect 检查 DOM
Angular 官方文档明确提醒：很多“检查 DOM 变化”的需求，其实更适合：
- `ResizeObserver`
- `MutationObserver`
- `IntersectionObserver`

而不是在 `effect` / `afterRenderEffect` 里轮询或重复测量。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

例如：
- 监听元素尺寸变化 → `ResizeObserver`
- 监听元素是否进入视口 → `IntersectionObserver`
- 监听外部库修改 DOM → `MutationObserver`

这通常比“每次 render 后都去读一遍 DOM”更高效。

### 6. 与 Angular 特性耦合时优先 `Renderer2`
官方 DOM APIs 文档还提到，`Renderer2` 的价值主要在于某些和 Angular 特性耦合的 DOM 操作，比如：
- 创建的元素参与样式封装
- 某些动画/平台抽象场景  
但大多数现代浏览器端场景，如果你已经明确在浏览器、且是简单 DOM 行为，`ElementRef.nativeElement` + render callback 更直接。只有涉及 Angular 抽象层或平台兼容需求时，再考虑 `Renderer2`。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

---

## 不推荐的做法

### 不推荐 1：在普通 `effect()` 里直接读写 DOM
因为官方明确说明：普通 `effect` 适合同步到命令式、非 signal API；但如果你需要 DOM 已更新后的结果，应该改用 `afterRenderEffect`。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 不推荐 2：在 `ngAfterViewInit` / `ngAfterViewChecked` 里做核心 DOM 同步
官方文档明确说：**不要在其他 Angular 生命周期钩子里直接操作 DOM**。这是现在比旧习惯更“Signal-first”的推荐方式。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

### 不推荐 3：用 `effect` 把状态复制到 DOM 相关 signal，再二次同步
如果是状态关系，用 `computed`；如果是 DOM 副作用，直接 render callback。不要中间多做一层“为了 effect 而 effect”。官方也提醒：effects 应该是最后才用的 API，不要拿来传播状态变化。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

---

## 一张选择表

### 场景 1：聚焦输入框
- 推荐：`afterNextRender({ write: ... })`
- 原因：只需一次，且依赖 DOM 已存在。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

### 场景 2：根据 signal 更新第三方图表/编辑器
- 推荐：首次 `afterNextRender` 初始化，后续 `afterRenderEffect` 更新。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 场景 3：读取元素尺寸再调整布局
- 推荐：`afterRenderEffect` 分 phases，读写分离。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 场景 4：监听元素大小变化
- 推荐：`ResizeObserver`，必要时在 `afterNextRender` 里注册、在 cleanup/destroy 时释放。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

### 场景 5：纯视觉状态切换
- 推荐：模板绑定，不操作 DOM。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

---

## SSR / Hydration 注意点

Angular 官方文档说明：
- `afterNextRender` / `afterEveryRender` / `afterRenderEffect` **只在客户端运行**
- 它们**不会在 SSR 或预渲染期间运行**
- Hydration 场景里，如果是第三方脚本/DOM 操作，官方 hydration 文档建议考虑 `AfterNextRender`，以延后到 hydration 后处理完成之后再执行。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))

所以如果你在做：
- 地图 SDK
- 图表库
- 编辑器
- 广告脚本
- 任何会改写 DOM 的第三方库

通常都应优先放到 `afterNextRender`，而不是构造阶段或传统 view hook。([angular.dev](https://angular.dev/guide/hydration?utm_source=openai))

---

## 我给你的最终建议

在 **Signal-first Angular** 里，DOM 相关最佳实践可以压缩成这四条：

1. **先问自己能不能用模板绑定解决**；能就不要碰 DOM。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))
2. **一次性 DOM 初始化用 `afterNextRender`**。([v18.angular.dev](https://v18.angular.dev/guide/components/dom-apis/?utm_source=openai))
3. **随 signal 变化、且要求 DOM 已更新后执行的逻辑，用 `afterRenderEffect`**。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))
4. **读写分 phase；持续观察优先 Observer API；第三方 DOM 库初始化考虑 hydration/SSR 约束**。([angular.dev](https://angular.dev/guide/signals/effect?utm_source=openai))

如果你愿意，我可以下一步直接给你一套**可复制的 Angular 20 组件模板**，分别演示：
- `focus input`
- `measure element`
- `chart.js / echarts`
- `ResizeObserver`
- `Renderer2` 版本与 `nativeElement` 版本对比
