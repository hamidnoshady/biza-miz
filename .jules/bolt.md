## 2024-05-18 - Redundant Array Creation in Loops
**Learning:** Found an O(G * L) array creation issue where `Array.from` was being called inside a map iteration across multiple table line items.
**Action:** Always extract dynamically built option arrays that depend solely on component state (e.g. `guestCount`) into a `useMemo` above the render loop to prevent redundant allocations and maintain referential equality.
## 2025-02-23 - Memoizing Arrays Without Hoisting Filter Breaks Cache
**Learning:** Extracting an options array into a `useMemo` to prevent per-render reallocation fails if the data it depends on is created via `.filter()` directly in the render body. `.filter()` creates a new array reference every render, causing the `useMemo` dependency check to fail and recalculate anyway.
**Action:** Always move the `.filter()` operation inside the `useMemo` block and depend on the raw data array, or memoize the `.filter()` result itself before passing it to subsequent derived state hooks.

## 2026-09-01 - Extract Category Filtering from Render Loop
**Learning:** Filtering a large array of N items for each of C categories within a render loop causes O(N*C) computations, which blocks the main thread during high-frequency events like text searching. Extracting it to a useMemo block using `.filter()` creates new arrays each time, breaking the cache unless dependencies are correct.
**Action:** Use a single O(N) pass to group items into a `Map<string, Item[]>` inside `useMemo`, allowing O(1) lookups during the category render loop and maintaining stable references.
## 2024-11-20 - Memoizing Options Arrays Driven by Input State
**Learning:** In React list views or search dialogs, arrays that require string normalization (like `toPersianDigits`) or regex operations for each item can become a severe performance bottleneck if recreated on every keystroke. Specifically, in `src/app/dashboard/floor/session-panel.tsx`, `customerOptions` was recomputed on every render (driven by a `customerQuery` input state), which caused jank on large datasets.
**Action:** When an options array relies on a base dataset (like `customers`) but the component has rapid state updates (like text inputs), wrap the array creation in a `useMemo` dependent only on the base dataset (e.g. `[customers]`). Ensure you extract any expensive string normalization into the memoized block.
## 2026-09-11 - Documenting useDeferredValue Intentions
**Learning:** When using `useDeferredValue` and a precomputed search index as a React list view performance optimization, missing comments on these mechanisms can be rejected in code review because it violates 'Bolt' persona rules about code documentation.
**Action:** Always add inline comments explaining the `useDeferredValue` deferral and the O(N) pre-computation index optimizations directly in the code to ensure intent is clear.
## 2024-09-12 - O(N) filtering inside list rendering

**Learning:** When a list view (like the POS screen products list) calls a seemingly lightweight helper function (`attachedGroups`) that filters arrays under the hood on every item mapping iteration, it causes significant typing delay in search bars due to repeated O(N * M) calculations on the main thread.

**Action:** Identify and lift expensive O(N) array filtering operations from inside `.map()` render loops by using `useMemo` to construct a pre-computed data structure (like a `Map`) keyed by the entity ID, allowing the render loop to perform fast O(1) lookups instead.
## 2025-02-27 - Pre-Grouping Relations for O(1) Component Render
**Learning:** React component lists (like ItemRow in MenuManager) frequently filter secondary arrays inside their render scope (`links.filter(l => l.menuItemId === item.id)`). This turns an O(N) render into an O(N^2) operation, causing severe bottlenecks on menus with hundreds of items.
**Action:** Always extract relational array filtering into a parent `useMemo` that builds a `Map<id, RelatedItem[]>`. Pass down `map.get(id) ?? []` to child components to reduce relation lookup time from O(N) to O(1).
## 2025-02-27 - Pre-Grouping Relations for O(1) Component Render
**Learning:** React component lists (like ItemRow in MenuManager) frequently filter secondary arrays inside their render scope (`links.filter(l => l.menuItemId === item.id)`). This turns an O(N) render into an O(N^2) operation, causing severe bottlenecks on menus with hundreds of items.
**Action:** Always extract relational array filtering into a parent `useMemo` that builds a `Map<id, RelatedItem[]>`. Pass down `map.get(id) ?? []` to child components to reduce relation lookup time from O(N) to O(1).
## 2024-05-24 - Extract derived static operations like column configurations out of render loops
**Learning:** In highly configurable data grids (like the Data Table component), computing visual representation derived from props (such as filtering which columns should be shown on mobile views) inside the row rendering loop creates O(N * C) operations and allocates N new arrays on each render.
**Action:** Always pre-calculate and cache derived structure data (like the column layout) into a `React.useMemo` at the root of the component whenever the input schema is stable relative to the data rows.
## 2024-11-21 - Avoid useMemo for simple array operations
**Learning:** In React components like order modals (`src/app/dashboard/orders/order-detail-modal.tsx`), arrays of items are often small. Using `useMemo` for simple `.filter()` or `.reduce()` calls on these arrays introduces overhead for closure allocations and dependency checks that outweighs any re-render saving. It is considered a premature micro-optimization unless the array is proven to be massive.
**Action:** Do not use `useMemo` for primitive O(N) operations on small lists like cart or order items. Only apply it to expensive derived state or large data tables when a real bottleneck is observed.
## 2025-02-20 - Memoizing list item relational lookups
**Learning:** Found a common pattern where list components look up relational data (like categories or links) using `array.find()` directly inside the `map` render loop. This causes O(N^2) complexity where N is items and C is the related data array size.
**Action:** Replace `array.find()` inside render loops with an O(1) `useMemo` Map lookup at the parent component level. Always ensure `categoriesById` or similar Maps are passed down as props to individual item rows.
