#include "types.h"

#if (SELECTED * 3 + 1) == 7
State g_state;
int g_index;
static void Enter_A(int x) { g_state.count = x; }
static void Run_A(int x) { g_state.count += x; }
static void Enter_B(int x) { g_state.other = x; }
static void Run_B(int x) { ++g_state.other; }
static void Wrong(double x) { g_state.other = (int)x; }
void (*wrong_handler)(double) = Wrong;
typedef void (*Unknown)(char);

const StateStep g_tbl[] = { { Enter_A, Run_A }, { .run = Run_B, .enter = Enter_B } };
Fn const g_handlers[] = { Enter_A, Run_A };
Fn const g_sparse[5] = { [3] = Enter_B };

static void write_through(int *p) { ++*p; }

FUNC(void, RTE_CODE) Runnable(void) {
    RUN_WITH_ARG(Enter_A, header_value());
    g_tbl[1].enter(1);
    g_handlers[1](2);
    g_sparse[3](3);
    g_tbl[g_index].run(4);
    write_through(&g_state.count);
}

void Dispatch(Fn fp, const StateStep *ops, Unknown unknown) {
    fp(1);
    ops->run(2);
    unknown('a');
}
int Read(void) { return g_state.count; }
#else
int g_inactive;
void Inactive(void) { ++g_inactive; }
#endif
