#include "demo.h"

/* 换挡主控状态：被 main / can / nvm / diag 多个模块读写 */
GearCtx g_gear;

static int Gear_Retry(unsigned char target);
static unsigned char Gear_NextGear(unsigned char cur, unsigned char target);

void Shift_Up(void);
void Shift_Down(void);

/* 目标挡位与实际挡位的步进判断 */
static unsigned char Gear_NextGear(unsigned char cur, unsigned char target)
{
    if (cur < target) {
        return (unsigned char)(cur + 1u);
    }
    if (cur > target) {
        return (unsigned char)(cur - 1u);
    }
    return cur;
}

/* 换挡失败重试：次数超限就报故障码 */
static int Gear_Retry(unsigned char target)
{
    static unsigned char tries = 0u;

    if (++tries > MAX_RETRY) {
        tries = 0u;
        g_gear.fault = 1u;
        g_faultCode = 0x21;
        return -3;
    }
    g_gear.retry++;
    g_gear.current = Gear_NextGear(g_gear.current, target);
    return 0;
}

/* 真正执行换挡：挡位一致就直接返回 */
int Gear_Apply(unsigned char target)
{
    if (target >= GEAR_COUNT) {
        return -1;
    }
    if (g_gear.current == target) {
        g_gear.ready = 1u;
        return 0;
    }
    if (g_gear.fault != 0u) {
        return -2;
    }

    g_gear.target = target;
    g_gear.shiftCnt++;

    if (Gear_Retry(target) != 0) {
        Diag_Report(g_gear.fault);
        return -3;
    }

    g_gear.ready = 1u;
    return 0;
}

/* 挡位自检：上电时确认当前挡位合法 */
void Gear_SelfTest(void)
{
    if (g_gear.current >= GEAR_COUNT) {
        g_gear.current = 0u;
        g_gear.fault = 1u;
    }
    g_gear.shiftCnt = 0u;
    g_gear.retry = 0u;
    g_gear.ready = 0u;
}
