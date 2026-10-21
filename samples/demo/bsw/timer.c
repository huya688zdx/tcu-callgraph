#include "demo.h"

/* 系统节拍：中断里累加 */
static volatile unsigned int s_tickCount = 0u;
static unsigned char s_timerReady = 0u;

void Timer_Init(void)
{
    s_tickCount = 0u;
    s_timerReady = 1u;
    g_tick = 0u;
}

/* 1ms 中断：维护节拍并把心跳写到全局 */
void Timer_Isr(void)
{
    if (s_timerReady == 0u) {
        return;
    }
    s_tickCount++;
    if ((s_tickCount % 10u) == 0u) {
        g_tick++;
    }
}

unsigned int Timer_GetTicks(void)
{
    return s_tickCount;
}

/* 延时：按节拍空转，供初始化时序使用 */
void Timer_Delay(unsigned int ms)
{
    unsigned int start = s_tickCount;

    while ((s_tickCount - start) < ms) {
        /* 空转等节拍 */
    }
}

void Timer_Stop(void)
{
    s_timerReady = 0u;
}
