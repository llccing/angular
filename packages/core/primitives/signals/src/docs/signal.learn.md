这个文件实现的是 **Angular Signals 底层里“可写 signal”的核心原语**。它负责三件事：

1. **创建 signal**
2. **读取 signal**
3. **写入 signal 后通知依赖它的消费者更新**

你可以把它理解成：这是一个很小但很核心的“响应式值容器”实现。

---

## 一句话概括

`signal.ts` 提供了一个带有依赖追踪能力的值节点 `SignalNode`，并围绕它生成：

- `getter()`：读取值，并记录“谁读了它”
- `set(newValue)`：修改值，如果变了就触发依赖更新
- `update(fn)`：基于旧值计算新值再写回

---

# 1. 这个文件在整个 signals 系统里的角色

这个文件本身**不实现完整的响应式系统**，而是站在比较底层的位置：

- 它定义了 **signal 节点的数据结构**
- 调用 `graph.ts` 中的通用响应式图机制：
  - `producerAccessed`
  - `producerNotifyConsumers`
  - `producerIncrementEpoch`
  - `producerUpdatesAllowed`
  - `REACTIVE_NODE`
  - `SIGNAL`

也就是说：

- `signal.ts` = “值容器 + 写入逻辑”
- `graph.ts` = “依赖图与调度逻辑”

所以这个文件本质上是在把一个普通值包装成**响应式生产者（producer）**。

---

# 2. 先看核心数据结构

## `SignalNode<T>`

```ts
export interface SignalNode<T> extends ReactiveNode {
  value: T;
  equal: ValueEqualityFn<T>;
}
```

这里的 `SignalNode` 继承自 `ReactiveNode`，并额外增加两个字段：

- `value: T`
  - 真正存储 signal 当前值的地方
- `equal: ValueEqualityFn<T>`
  - 比较新旧值是否相等的函数

所以一个 signal 节点本质上就是：

- 一个响应式图节点
- 外加当前值
- 外加相等性判断逻辑

---

# 3. getter / setter / updater 的类型

```ts
export type SignalBaseGetter<T> = (() => T) & {readonly [SIGNAL]: unknown};
export type SignalSetter<T> = (newValue: T) => void;
export type SignalUpdater<T> = (updateFn: (value: T) => T) => void;
```

这里 Angular 用的是一种很典型但很巧妙的设计：

## getter 是一个函数

signal 不是 `.value` 访问，而是：

```ts
count()
```

而不是：

```ts
count.value
```

所以 getter 的类型就是 `() => T`。

但它还被偷偷挂了一个属性：

```ts
{ readonly [SIGNAL]: unknown }
```

这意味着 getter 虽然表面上是函数，但内部还能通过一个 symbol-like key 拿到对应的底层节点。

---

## `SignalGetter<T>`

```ts
export interface SignalGetter<T> extends SignalBaseGetter<T> {
  readonly [SIGNAL]: SignalNode<T>;
}
```

这说明最终返回的 getter 函数上，实际绑定的是：

- 一个可调用函数
- 同时携带 `[SIGNAL]` 属性，指向对应 `SignalNode`

这个设计非常关键，因为它把：

- **用户 API**：`signal()`
- **内部状态**：node

绑定在了一起。

---

# 4. `createSignal` 是怎么创建 signal 的

```ts
export function createSignal<T>(
  initialValue: T,
  equal?: ValueEqualityFn<T>,
): [SignalGetter<T>, SignalSetter<T>, SignalUpdater<T>] {
```

这个函数返回一个三元组：

- getter
- set
- update

---

## 第一步：创建节点

```ts
const node: SignalNode<T> = Object.create(SIGNAL_NODE);
node.value = initialValue;
if (equal !== undefined) {
  node.equal = equal;
}
```

这里不是直接写一个对象字面量，而是：

```ts
Object.create(SIGNAL_NODE)
```

意思是让 `node` 以 `SIGNAL_NODE` 为原型。

这样做的好处是：

- 默认字段共享在原型上
- 每个 signal 实例只覆盖自己的必要字段
- 节省一些对象初始化成本
- 保持节点结构统一

然后它会设置：

- `node.value = initialValue`
- 如果传了自定义比较器，就覆盖默认的 `equal`

---

## 第二步：创建 getter

```ts
const getter = (() => signalGetFn(node)) as SignalGetter<T>;
(getter as any)[SIGNAL] = node;
```

这里创建了一个闭包函数 `getter`，调用时会执行：

```ts
signalGetFn(node)
```

也就是从对应 node 里读值。

然后把底层 node 挂到 getter 的 `[SIGNAL]` 属性上。

所以用户拿到的是函数，但 Angular 内部仍能通过 getter 找到底层节点。

---

## 第三步：开发模式下自定义 `toString`

```ts
if (typeof ngDevMode !== 'undefined' && ngDevMode) {
  getter.toString = () =>
    `[Signal${node.debugName ? ' (' + node.debugName + ')' : ''}: ${String(node.value)}]`;
}
```

这纯粹是为了调试体验。

开发模式下，如果你打印一个 signal，能看到类似：

```ts
[Signal: 123]
```

或者带 debugName：

```ts
[Signal (count): 123]
```

便于调试。

---

## 第四步：运行 post-create hook

```ts
runPostProducerCreatedFn(node);
```

这说明 signal 创建后，还会执行一个“producer 创建后的钩子”。

这个机制不在本文件实现，而是在更底层图系统里。通常这种 hook 用于：

- 调试
- DevTools 集成
- 创建后附加额外行为

---

## 第五步：创建 set/update 并返回

```ts
const set = (newValue: T) => signalSetFn(node, newValue);
const update = (updateFn: (value: T) => T) => signalUpdateFn(node, updateFn);
return [getter, set, update];
```

于是最终得到：

- `getter()` 读值
- `set(v)` 写值
- `update(fn)` 基于旧值更新

---

# 5. 读取是怎么实现的：`signalGetFn`

```ts
export function signalGetFn<T>(node: SignalNode<T>): T {
  producerAccessed(node);
  return node.value;
}
```

这个函数非常短，但非常关键。

读取 signal 时做了两件事：

1. `producerAccessed(node)`
2. `return node.value`

---

## `producerAccessed(node)` 的意义

这是响应式依赖收集的关键。

它的语义大概是：

> “当前这个 producer 被读取了。”

如果此时外层正处于某个 `computed` 或 `effect` 的执行上下文中，那么图系统就会记住：

- 当前消费者依赖了这个 signal

以后这个 signal 改变时，就可以准确通知到依赖它的消费者。

所以：

- **读值不仅是拿数据**
- **也是依赖追踪发生的时机**

---

# 6. 写入是怎么实现的：`signalSetFn`

```ts
export function signalSetFn<T>(node: SignalNode<T>, newValue: T) {
  if (!producerUpdatesAllowed()) {
    throwInvalidWriteToSignalError(node);
  }

  if (!node.equal(node.value, newValue)) {
    node.value = newValue;
    signalValueChanged(node);
  }
}
```

这是 signal 写入的核心逻辑。

---

## 第一步：检查当前是否允许写

```ts
if (!producerUpdatesAllowed()) {
  throwInvalidWriteToSignalError(node);
}
```

Signals 系统并不是任何时候都允许随便写值。

比如在某些不允许产生副作用或不允许写入的上下文里，写 signal 可能会破坏响应式图的一致性。

所以这里先调用：

- `producerUpdatesAllowed()`

如果不允许，就抛错：

- `throwInvalidWriteToSignalError(node)`

这是一种运行时保护机制。

---

## 第二步：比较新旧值是否真的变化

```ts
if (!node.equal(node.value, newValue)) {
```

这里用的不是固定的 `===`，而是 `node.equal`。

默认是 `defaultEquals`，但可以在创建 signal 时传入自定义比较函数。

这样 Angular 可以支持：

- 默认引用/值比较
- 或某些自定义相等规则

如果新旧值“相等”，就什么都不做。

这点很重要，因为它避免了无意义的通知和重复计算。

---

## 第三步：更新值并触发变更传播

```ts
node.value = newValue;
signalValueChanged(node);
```

真正更新以后，进入统一的“值变化处理流程”。

---

# 7. `update` 是怎么实现的：`signalUpdateFn`

```ts
export function signalUpdateFn<T>(node: SignalNode<T>, updater: (value: T) => T): void {
  if (!producerUpdatesAllowed()) {
    throwInvalidWriteToSignalError(node);
  }

  signalSetFn(node, updater(node.value));
}
```

`update` 本质上只是 `set` 的语法糖。

逻辑是：

1. 检查是否允许写
2. 用 `updater(node.value)` 计算新值
3. 再交给 `signalSetFn`

例如：

```ts
count.update(v => v + 1)
```

底层等价于：

```ts
count.set(count() + 1)
```

只不过这里直接访问 `node.value`，避免额外走一层 getter。

---

# 8. signal 更新后发生了什么：`signalValueChanged`

```ts
function signalValueChanged<T>(node: SignalNode<T>): void {
  node.version++;
  producerIncrementEpoch();
  producerNotifyConsumers(node);
  postSignalSetFn?.(node);
}
```

这是真正的“通知传播”核心。

当一个 signal 值变化后，做了四件事：

---

## 8.1 `node.version++`

每个节点有版本号。

值一变，版本号递增。

作用通常是：

- 让依赖系统快速判断某节点是否发生过变化
- 帮助 computed/effect 做缓存失效判断
- 避免不必要的重新计算

可以理解成“这个节点的变更序号”。

---

## 8.2 `producerIncrementEpoch()`

这会增加一个全局 epoch。

可以把 epoch 理解为：

- 全局响应式系统的“时间戳”或“代数”

任何 producer 发生变化，整个系统的 epoch 往前推进一格。

这通常用于：

- 快速判断“系统是否自上次检查后发生过任意变更”
- 配合局部 version 做更高效的脏检查

---

## 8.3 `producerNotifyConsumers(node)`

这一步最关键：

> 通知所有依赖这个 signal 的消费者

这些消费者可能是：

- `computed`
- `effect`
- 其他派生节点

注意这里大概率不是“立刻同步重算所有下游值”，而是把依赖者标记为脏或安排后续处理。真正的调度细节在 `graph.ts`。

所以这个文件只负责：

- “我变了”
- “告诉所有依赖我的人”

至于依赖者何时重新执行，是图系统决定的。

---

## 8.4 `postSignalSetFn?.(node)`

最后调用一个可选 hook。

这个 hook 是文件顶部定义的：

```ts
let postSignalSetFn: ReactiveHookFn | null = null;
```

它的注释写得很清楚：

> 当 WritableSignal 更新后调用，可用于实现某些效果，比如在 set signal 时同步运行 effects。

所以这是一个扩展点，让外部系统可以在 signal 更新后插入自定义行为。

---

# 9. post-set hook 机制

## 设置 hook：`setPostSignalSetFn`

```ts
export function setPostSignalSetFn(fn: ReactiveHookFn | null): ReactiveHookFn | null {
  const prev = postSignalSetFn;
  postSignalSetFn = fn;
  return prev;
}
```

这个 API 用来安装或替换全局的 `postSignalSetFn`。

它返回旧值，这样调用方可以：

- 临时替换 hook
- 执行一些逻辑
- 再恢复旧 hook

这是很常见的 hook 管理方式。

---

## 触发 hook：`runPostSignalSetFn`

```ts
export function runPostSignalSetFn<T>(node: SignalNode<T>): void {
  postSignalSetFn?.(node);
}
```

这只是一个公开包装，允许别处显式调用当前 hook。

虽然 `signalValueChanged()` 里已经直接调用了 hook，但这个公开函数可能是为了统一入口或供别处复用。

---

# 10. 默认节点模板：`SIGNAL_NODE`

```ts
export const SIGNAL_NODE: SignalNode<unknown> = /* @__PURE__ */ (() => {
  return {
    ...REACTIVE_NODE,
    equal: defaultEquals,
    value: undefined,
    kind: 'signal',
  };
})();
```

这是所有 signal 节点的“原型模板”。

它基于 `REACTIVE_NODE` 扩展而来，并补充 signal 特有字段：

- `equal: defaultEquals`
- `value: undefined`
- `kind: 'signal'`

---

## 为什么用 IIFE？

注释里写了：

```ts
// Note: Using an IIFE here to ensure that the spread assignment is not considered
// a side-effect, ending up preserving `COMPUTED_NODE` and `REACTIVE_NODE`.
```

简单说，这是为了帮助构建工具/压缩器正确做 tree-shaking 和副作用分析。

`/* @__PURE__ */` + IIFE 是一种常见模式，告诉优化器：

- 这个表达式是纯的
- 没有副作用
- 如果没被用到，可以安全优化

---

# 11. 这个文件的整体运行流程

可以把整个实现总结成下面这条链路。

---

## 创建阶段

```ts
const [get, set, update] = createSignal(0);
```

发生的事：

1. 基于 `SIGNAL_NODE` 创建一个 `node`
2. 设置 `node.value = 0`
3. 创建 getter 函数，内部闭包持有 node
4. 把 `node` 挂到 getter 的 `[SIGNAL]` 属性
5. 返回 getter/setter/updater

---

## 读取阶段

```ts
get()
```

发生的事：

1. 调用 `signalGetFn(node)`
2. `producerAccessed(node)` 记录依赖
3. 返回 `node.value`

---

## 写入阶段

```ts
set(1)
```

发生的事：

1. 检查当前上下文是否允许写
2. 用 `equal(old, new)` 比较是否变化
3. 如果变化：
   - 更新 `node.value`
   - `node.version++`
   - 全局 epoch 增加
   - 通知依赖的 consumers
   - 调用 post-set hook

---

## 更新阶段

```ts
update(v => v + 1)
```

发生的事：

1. 检查是否允许写
2. 用旧值算出新值
3. 复用 `signalSetFn`

---

# 12. 这个设计的几个关键点

## 12.1 用户 API 很轻

用户看到的是：

- 一个函数式 getter
- 一个 set
- 一个 update

API 非常简洁。

---

## 12.2 内部状态和外部 API 绑定得很紧凑

通过：

```ts
getter[SIGNAL] = node
```

Angular 把“函数式 API”和“底层节点对象”绑在一起，既保持了用户体验，又方便内部系统操作。

---

## 12.3 读取时追踪依赖，写入时通知依赖

这是响应式系统最核心的模式：

- **read => track**
- **write => trigger**

这个文件完整体现了这一点：

- `signalGetFn` 中调用 `producerAccessed`
- `signalValueChanged` 中调用 `producerNotifyConsumers`

---

## 12.4 相等性判断避免无效更新

通过 `equal`，只有真正变化时才传播更新。这对性能很重要。

---

## 12.5 图系统和 signal 值逻辑解耦

这个文件只关心：

- 节点长什么样
- 什么时候算读
- 什么时候算写
- 写后要通知图系统

而不关心：

- 消费者列表怎么存
- computed 怎么重新求值
- effect 何时调度

这些都委托给 `graph.ts`。

这种分层让实现更清晰。

---

# 13. 可以把它类比成什么

可以类比成一个“带监听能力的变量”：

普通变量：

```ts
let x = 1;
x = 2;
```

signal 变量：

```ts
const [x, setX, updateX] = createSignal(1);
x();         // 读时登记依赖
setX(2);     // 写时通知依赖者
```

区别不在“存值”，而在于：

- 读的时候能知道“谁依赖我”
- 写的时候能知道“该通知谁”

---

# 14. 一个简化伪代码版本

你可以把这个文件抽象成下面这样：

```ts
type Node<T> = {
  value: T;
  version: number;
  equal: (a: T, b: T) => boolean;
  consumers: Set<any>;
};

function createSignal<T>(initial: T) {
  const node = {
    value: initial,
    version: 0,
    equal: Object.is,
    consumers: new Set(),
  };

  function getter() {
    trackDependency(node);
    return node.value;
  }

  function set(newValue: T) {
    if (!node.equal(node.value, newValue)) {
      node.value = newValue;
      node.version++;
      notifyConsumers(node);
    }
  }

  function update(fn: (v: T) => T) {
    set(fn(node.value));
  }

  return [getter, set, update];
}
```

Angular 的真实实现比这个多了：

- 写入合法性校验
- 全局 epoch
- hook
- 与统一 reactive graph 的整合
- 调试支持

但本质上就是这个模型。

---

# 15. 总结

这个文件实现的是 Angular Signals 中最基础的 **writable signal primitive**：

- `createSignal` 创建底层节点以及 getter/setter/updater
- `signalGetFn` 在读取时做依赖收集
- `signalSetFn` 在写入时做合法性检查与值变更判断
- `signalUpdateFn` 基于旧值更新
- `signalValueChanged` 负责版本递增、epoch 推进、通知消费者、执行 hook
- `SIGNAL_NODE` 提供所有 signal 节点共享的默认模板

它的核心思想可以概括为：

> **把一个普通值包装成响应式图中的 producer：读取时登记依赖，写入时通知依赖。**

如果你愿意，我下一步可以继续给你讲两层更深入的内容之一：

1. **逐行解释这个文件**
2. **结合 `graph.ts` 解释 signal/computed/effect 是怎么串起来的**
