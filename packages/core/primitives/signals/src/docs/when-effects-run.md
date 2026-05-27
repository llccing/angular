先说结论：

1. **这个 primitives 层里的 `effect` / `watch` 本身不决定“何时执行”**，它只定义：
   - 依赖如何收集
   - 变脏后如何标记 / 调度
   - 真正执行时如何重跑  
2. **“执行时机”取决于上层 runtime / scheduler**。  
   从你给的代码里，最能看出来的是 `watch.ts`：依赖变化后不是立刻执行用户函数，而是调用 `schedule(watch)`，说明**时机由调度器决定**。  
3. 在 **Signal 为主的新 Angular** 里，生命周期的重心已经从“每轮变更检测钩子”转向：
   - **创建 / 销毁**
   - **响应式依赖变化**
   - **渲染后阶段**
   - **副作用清理**
4. 最佳实践是：
   - **状态派生用 `computed`**
   - **副作用用 `effect`**
   - **跨轮次资源管理用 cleanup / destroy**
   - **不要把 `effect` 当 `computed` 用**
   - **尽量围绕 signal 图组织代码，而不是围绕传统 hook 链条组织**

下面我分开讲。

---

# 1. 从这份代码看，Effect 到底什么时候执行？

你贴的 `graph.ts` 本身其实已经给出一个重要信号：

- 变化传播时，Angular **只会把 consumer 标记为 dirty**
- 然后通过回调把“后续怎么执行”交给节点自己

关键代码：

```typescript name=graph.ts url=https://github.com/angular/angular/blob/4f9ee3c056afe3f43f7d1e6837e2f92ace208eb5/packages/core/primitives/signals/src/graph.ts#L359-L363
export function consumerMarkDirty(node: ReactiveNode): void {
  node.dirty = true;
  producerNotifyConsumers(node);
  node.consumerMarkedDirty?.(node);
}
```

这说明：
- 上游 producer 变了
- 下游 consumer 被标脏
- **然后调用 `consumerMarkedDirty`**
- 至于要不要立即执行、排队执行、合并执行，不在 `graph.ts` 决定

也就是说，**graph 只负责“变脏传播”，不负责“具体执行时机”**。  
citeturn0commentaryto=multi_tool_use.parallel0

---

# 2. 从哪里能最清楚看出 effect/watch 是“调度执行”的？

最清楚的是 `watch.ts`。

看这里：

```typescript name=watch.ts url=https://github.com/angular/angular/blob/4f9ee3c056afe3f43f7d1e6837e2f92ace208eb5/packages/core/primitives/signals/src/watch.ts#L143-L152
const WATCH_NODE: Omit<WatchNode, 'fn' | 'schedule' | 'ref'> = /* @__PURE__ */ (() => {
  return {
    ...REACTIVE_NODE,
    consumerIsAlwaysLive: true,
    consumerAllowSignalWrites: false,
    consumerMarkedDirty: (node: WatchNode) => {
      if (node.schedule !== null) {
        node.schedule(node.ref);
      }
    },
    cleanupFn: NOOP_CLEANUP_FN,
  };
})();
```

这段几乎是直接写明白了：

> 当 watch/effect 变 dirty 时，不是这里直接跑 `fn`，而是调用 `schedule(node.ref)`。

所以 effect/watch 的**真实执行时机**由传进来的 `schedule` 决定。  
如果调度器想：
- 立刻执行：就立即 `watch.run()`
- 微任务执行：排到 microtask
- 渲染后执行：排到 render 后阶段
- 批量合并：收集后统一 run

都可以。  
citeturn0commentaryto=multi_tool_use.parallel0

---

# 3. `run()` 又是在什么时候真正执行副作用？

还是看 `watch.ts`：

```typescript name=watch.ts url=https://github.com/angular/angular/blob/4f9ee3c056afe3f43f7d1e6837e2f92ace208eb5/packages/core/primitives/signals/src/watch.ts#L98-L125
const run = () => {
  if (node.fn === null) {
    return;
  }

  if (isInNotificationPhase()) {
    throw new Error(
      typeof ngDevMode !== 'undefined' && ngDevMode
        ? 'Schedulers cannot synchronously execute watches while scheduling.'
        : '',
    );
  }

  node.dirty = false;
  if (node.version > 0 && !consumerPollProducersForChange(node)) {
    return;
  }
  node.version++;

  const prevConsumer = consumerBeforeComputation(node);
  try {
    node.cleanupFn();
    node.cleanupFn = NOOP_CLEANUP_FN;
    node.fn(registerOnCleanup);
  } finally {
    consumerAfterComputation(node, prevConsumer);
  }
};
```

这里能看出几件事：

## 3.1 不能在 notification phase 同步跑
`isInNotificationPhase()` 时会报错。

这说明 Angular 的设计是：

- 先传播“谁脏了”
- 再进入 effect/watch 的执行阶段

所以**不是边传播边执行**。  
这是为了防止图结构在半更新过程中又发生读取 / 执行，导致不一致。  
citeturn0commentaryto=multi_tool_use.parallel0

## 3.2 即使被调度，也会先做“是否真的变化”的检查
```ts
if (node.version > 0 && !consumerPollProducersForChange(node)) {
  return;
}
```

意思是：
- 不是每次 schedule 都一定重跑
- 如果依赖链最后证明没变，就跳过执行

所以它是：
- **push dirty**
- **pull verify**
- **then run**

## 3.3 执行前先 cleanup，再重新收集依赖
```ts
node.cleanupFn();
node.cleanupFn = NOOP_CLEANUP_FN;
node.fn(registerOnCleanup);
```

这说明 effect/watch 是典型的“上一轮清理 -> 下一轮执行”模型。

---

# 4. `effect.ts` 告诉我们什么？

`effect.ts` 这份 primitives 层代码更薄，但也能看出同样结构：

```typescript name=effect.ts url=https://github.com/angular/angular/blob/4f9ee3c056afe3f43f7d1e6837e2f92ace208eb5/packages/core/primitives/signals/src/effect.ts#L40-L57
export function runEffect(node: BaseEffectNode) {
  node.dirty = false;
  if (node.version > 0 && !consumerPollProducersForChange(node)) {
    return;
  }
  node.version++;
  const prevNode = consumerBeforeComputation(node);
  try {
    node.cleanup();
    node.fn();
  } finally {
    consumerAfterComputation(node, prevNode);
  }
}
```

它说明了 effect 的执行语义：

1. 清除 dirty
2. 如果依赖没真正变化则跳过
3. 进入 reactive context
4. 先 cleanup
5. 再执行 effect fn
6. 执行过程中重新收集依赖
7. 执行后 finalize

所以 effect 的本质不是“监听器回调”，而是：

> **一个会反复重新执行的 reactive consumer，每次执行都重新建立依赖图。**  
citeturn0commentaryto=multi_tool_use.parallel0

---

# 5. 那么在“新 Angular（Signals 为主）”里，生命周期应该怎么理解？

这里要分两层说：

## 5.1 从 primitives 角度看，生命周期其实只有这几个阶段

从你贴的 `graph.ts` / `watch.ts` / `effect.ts` 看，signal 世界里的底层生命周期更像：

1. **创建**
   - 节点被创建，producer / consumer 初始化
2. **首次运行 / 首次求值**
   - computed 首次被读
   - effect/watch 首次被 run
3. **依赖收集**
   - 运行期间谁被读了，就建立依赖
4. **变脏**
   - 上游变化，当前节点 dirty
5. **重算 / 重执行**
   - computed 在被读时重算
   - effect/watch 在被调度时重跑
6. **cleanup**
   - effect/watch 下一次运行前做清理
7. **destroy**
   - 从图中断开，释放依赖关系

这是一种**响应式生命周期**，而不是传统 Angular 那种“每轮 CD 钩子生命周期”。

---

## 5.2 从应用开发角度看，新 Angular 的生命周期重心已经变化了

如果你说的是“以 Signal 为主的新 Angular 组件开发”，那么实际思维应该从：

- `ngOnChanges`
- `ngDoCheck`
- `ngAfterViewChecked`

这种“变更检测周期钩子”

转向：

- **输入变化 -> signal 化**
- **派生状态 -> computed**
- **副作用响应 -> effect**
- **销毁 -> cleanup / DestroyRef / destroy**
- **DOM 渲染后工作 -> after render 类 API**

也就是说，重点从“每个 CD 周期我做什么”变成了：

> **当依赖变化时，我想重新算什么？重新执行什么？销毁什么？**

---

# 6. Signal 时代可以怎样理解“生命周期分类”

我给你一个更适合新 Angular 的分类法。

---

## A. 实例生命周期
这些还依然存在、而且很重要：

- 构造 / 注入阶段
- 初始化阶段
- 销毁阶段

适合做：
- 依赖注入
- 创建长期 signal / effect
- 注册资源
- 在 destroy 时清理资源

---

## B. 响应式生命周期
这是 Signal 时代最核心的：

- 某个 signal 被修改
- 某个 computed 失效
- 某个 effect 被标脏
- effect 在合适时机重跑
- cleanup 在下一次运行前触发

适合做：
- 派生状态
- 同步非 Angular 状态
- 发请求、订阅、取消订阅
- localStorage / title / URL / analytics 同步

---

## C. 渲染生命周期
Signal 时代依然有“渲染后”这一类需求：

- 读取 DOM 尺寸
- 操作焦点
- 做 canvas / third-party widget 初始化
- 与真实渲染结果耦合的工作

这些不适合放在 computed 里，更适合放在：
- 渲染后 hook / after render 类机制
- 或 effect + 明确的 DOM 安全时机

---

# 7. 最佳实践：Signal 时代怎么妥善利用生命周期

下面这些是最实用的。

---

## 7.1 用 `computed` 表达“状态之间的关系”，不要用 effect 去赋值派生状态

**推荐：**

```ts
const firstName = signal('A');
const lastName = signal('B');
const fullName = computed(() => `${firstName()} ${lastName()}`);
```

**不推荐：**

```ts
const fullName = signal('');
effect(() => {
  fullName.set(`${firstName()} ${lastName()}`);
});
```

为什么？

- `computed` 是纯派生，天然缓存、懒计算、依赖自动追踪
- `effect` 做这件事会制造额外写入和调度
- 更容易形成不必要的副作用链

**原则：**
> 能用 `computed`，就不要用 `effect`。

---

## 7.2 用 `effect` 做“副作用”，不要做“状态建模”

适合 `effect` 的事情：

- 同步 document.title
- 同步 localStorage
- 发请求 / 取消旧请求
- 打点埋点
- 调第三方 API
- 订阅外部对象，再 cleanup

例如：

```ts
effect((onCleanup) => {
  const query = searchText();

  const controller = new AbortController();
  fetch(`/api?q=${query}`, {signal: controller.signal});

  onCleanup(() => controller.abort());
});
```

这非常符合 `watch.ts` / `effect.ts` 的设计：  
**每次重跑前先 cleanup，上一次的副作用先收掉。**

---

## 7.3 把“资源生命周期”放进 cleanup / destroy

从 `watch.ts` 可以明显看出：

- 每次 `run()` 前会先执行 `cleanupFn`
- `destroy()` 时也会 cleanup 并断图

所以凡是这类资源：

- 定时器
- 事件监听
- 订阅
- AbortController
- WebSocket
- 第三方实例

都应该和 effect 的 cleanup 绑定，而不是散落在各处。

**模式：**

```ts
effect((onCleanup) => {
  const sub = someObservable.subscribe(...);
  onCleanup(() => sub.unsubscribe());
});
```

或者：

```ts
effect((onCleanup) => {
  const id = setInterval(..., 1000);
  onCleanup(() => clearInterval(id));
});
```

---

## 7.4 DOM 相关工作不要过早做

如果工作依赖“DOM 已经渲染完成”：

- 不要放 computed
- 不要在纯 signal 派生阶段就访问 DOM
- 应该放到真正适合的 render 后时机

比如：
- 测量元素尺寸
- 调 focus()
- 初始化第三方 UI 库

Signal 擅长的是**数据依赖图**，  
而 DOM 渲染完成是**渲染生命周期**，这两者不要混淆。

---

## 7.5 不要在 computed 里写 signal

从 `graph.ts` 这句就能看出来有意限制：

```typescript name=graph.ts url=https://github.com/angular/angular/blob/4f9ee3c056afe3f43f7d1e6837e2f92ace208eb5/packages/core/primitives/signals/src/graph.ts#L355-L357
export function producerUpdatesAllowed(): boolean {
  return activeConsumer?.consumerAllowSignalWrites !== false;
}
```

而 computed 默认不允许 signal writes。  
这是因为 computed 应该是纯函数式派生。

**最佳实践：**
- `computed` 只读不写
- 写入放到事件处理、effect 或明确命令式逻辑中

---

## 7.6 effect 不要承担“所有业务逻辑”

Signal 新手很容易把所有事情都塞进 effect：

```ts
effect(() => {
  if (a()) {
    b.set(...);
    c.set(...);
    d.set(...);
    doSomething();
  }
});
```

这样会让系统越来越像“隐式联动脚本”。

更好的拆分方式：

- 纯关系 -> `computed`
- 用户动作 -> 显式方法 / action
- 外部副作用 -> `effect`
- 资源回收 -> cleanup

这样图会清晰很多。

---

## 7.7 对“输入变化”的思维也要变

传统 Angular 常常在 `ngOnChanges` 里做派生。

Signal 时代更自然的做法是：

- 把输入转成 signal
- 用 computed 派生
- 用 effect 响应副作用

也就是从：

> “当输入变了，我在生命周期钩子里手动做事”

转成：

> “输入就是 reactive source，系统自动传播”

---

# 8. 如果把“Signal Angular 的生命周期”压缩成一张实战地图

我建议你这样记：

---

## 8.1 创建时做什么
做：
- 注入依赖
- 初始化源 signal
- 建立 computed
- 建立 effect
- 注册需要 destroy 的资源

不要做：
- 过重的同步副作用
- 依赖 DOM 已经稳定的工作

---

## 8.2 状态变化时做什么
做：
- 让 `computed` 自动派生
- 让 `effect` 自动处理副作用
- 使用 cleanup 撤销上一轮副作用

不要做：
- 手工在多个 hook 里同步状态
- effect 里反复 set 一堆派生 signal

---

## 8.3 渲染后做什么
做：
- DOM 测量
- focus
- 第三方 DOM 集成
- 和渲染结果强耦合的逻辑

不要做：
- 用 computed 访问 DOM
- 用普通 effect 假设 DOM 已经一定是最新

---

## 8.4 销毁时做什么
做：
- 依赖 effect cleanup
- destroy watcher/effect
- 清理订阅、监听器、timer、第三方实例

不要做：
- 把资源 cleanup 散落在多个地方
- 忘记释放长生命周期副作用

---

# 9. 从这份 primitives 代码里，能提炼出哪些特别重要的实践原则？

## 原则 1：依赖是运行时收集的
所以不要过度手工管理依赖列表。

## 原则 2：变化传播是“脏传播”，不是“立即执行”
所以不要假设 set 之后 effect 已经立刻跑完，时机取决于调度器。  
从 `watch.ts` 的 `schedule` 可以直接看出来。  
citeturn0commentaryto=multi_tool_use.parallel0

## 原则 3：effect 每次重跑前会 cleanup
所以副作用要设计成“可撤销、可重建”的。

## 原则 4：computed 是纯的、懒的、可缓存的
所以它应该承担派生状态，而不是外部副作用。

## 原则 5：destroy 是图生命周期的一部分
`consumerDestroy()` 会断开整张图的连接，所以长期存在的 reactive 资源必须和宿主实例生命周期绑定。  
见 `graph.ts` 中 `consumerDestroy()`。  
citeturn0commentaryto=multi_tool_use.parallel0

---

# 10. 一个很实用的“新 Angular 心法”

如果你现在写 Signal-first Angular，可以用下面这套判断：

### 问题 1：这是值，还是副作用？
- 值 -> `signal` / `computed`
- 副作用 -> `effect`

### 问题 2：这个值是原始状态，还是派生状态？
- 原始状态 -> `signal`
- 派生状态 -> `computed`

### 问题 3：这个副作用是否需要撤销？
- 需要 -> 用 cleanup

### 问题 4：这件事依赖 DOM 已渲染吗？
- 是 -> 放到 render 后时机，不要放纯派生逻辑里

### 问题 5：这是响应式问题，还是实例生命周期问题？
- 响应式问题 -> signal/computed/effect
- 实例问题 -> create/init/destroy

---

# 11. 最后用一句话总结你这个问题

**Effect 的执行时机，从这份代码里看，并不是“signal 一变立刻同步执行”，而是“signal 变化后先把 effect/watch 标脏，再通过 `consumerMarkedDirty -> schedule(...)` 交给上层调度器，在合适时机调用 `run()`/`runEffect()` 执行”。**  
这在 `graph.ts` 的 `consumerMarkDirty()` 和 `watch.ts` 的 `consumerMarkedDirty` / `run()` 里看得最清楚。  
citeturn0commentaryto=multi_tool_use.parallel0

而在 **Signal 为主的新 Angular** 里，最好的实践不是依赖传统“每轮生命周期钩子”，而是把代码分成：

- **源状态：signal**
- **派生状态：computed**
- **副作用：effect**
- **资源清理：cleanup / destroy**
- **DOM 后处理：render 后时机**

---

如果你愿意，我下一步可以继续给你两种更具体的内容之一：

1. **把 Angular 传统生命周期（OnInit / OnChanges / AfterViewInit / OnDestroy）映射到 Signal-first 写法**
2. **给你一套真实组件范式：表单、请求、DOM操作、cleanup 各该放哪**
