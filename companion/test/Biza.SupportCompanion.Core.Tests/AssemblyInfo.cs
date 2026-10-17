using Xunit;

// The suite is 60-odd sub-millisecond tests: parallelism buys nothing and
// scrambles failure output. Sequential, deterministic, in discovery order.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
