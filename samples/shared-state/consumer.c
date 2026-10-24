#include "shared.h"

/* 与 producer.c 同名，但文件私有，不能形成跨文件数据流。 */
static unsigned int s_count;

static unsigned int Scale(unsigned int value)
{
    return value / 100u;
}

/* 只读公共变量；按值传给 Scale 不会改写 g_rpm。 */
unsigned int Control_Read(void)
{
    /* 局部副本的修改也不应算成对 g_rpm 的写入。 */
    unsigned int snapshot = g_rpm;
    snapshot /= 100u;
    s_count++;
    return snapshot + Scale(g_rpm) + g_samples[g_index];
}

/* 同名形参遮蔽全局变量，这里不应出现任何公共变量引用。 */
unsigned int Debug_Echo(unsigned int g_rpm)
{
    return g_rpm;
}
