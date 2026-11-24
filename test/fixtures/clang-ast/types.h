#define FUNC(ret, memclass) ret
#define RUN_WITH_ARG(fn, arg) fn(arg)
typedef void (*Fn)(int);
typedef struct { Fn enter; Fn run; } StateStep;
typedef struct { int count; int other; } State;
static inline int header_value(void) { return 2; }
