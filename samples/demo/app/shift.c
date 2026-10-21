#include "demo.h"

/* 换挡曲线常量表：只读，4 个挡位各一条 */
const ShiftOps g_shiftTable[GEAR_COUNT] = {
    { 40u, 20u, 60u, 180u },
    { 60u, 35u, 90u, 200u },
    { 75u, 45u, 110u, 210u },
    { 90u, 55u, 120u, 220u },
};

static unsigned char s_shiftLock = 0u;

int Gear_Apply(unsigned char target);
void Gear_SelfTest(void);
void Shift_Up(void);
void Shift_Down(void);

/* 函数指针表：指定初始化（.成员 = 函数）→ 解析器识别成 fnptr 表 */
const GearOps g_gearOps = {
    .up   = Shift_Up,
    .down = Shift_Down,
};

void Shift_Init(void)
{
    s_shiftLock = 0u;
    Gear_SelfTest();
}

/* 按转速 / 车速查表判断该升挡还是降挡 */
void Shift_Check(unsigned short rpm, unsigned short speed)
{
    const ShiftOps *ops;
    unsigned char target;

    if (g_gear.fault != 0u || g_gear.ready == 0u) {
        return;
    }
    if (s_shiftLock != 0u) {
        return;
    }

    ops = &g_shiftTable[g_gear.current];

    if (rpm > ops->maxRpm && speed > ops->upSpeed) {
        Shift_Up();
    } else if (rpm < ops->minRpm && speed < ops->downSpeed) {
        Shift_Down();
    }

    target = g_gear.target;
    if (target != g_gear.current) {
        (void)Gear_Apply(target);
    }
}

void Shift_Up(void)
{
    if (g_gear.target + 1u < GEAR_COUNT) {
        g_gear.target++;
    }
    s_shiftLock = 1u;
}

void Shift_Down(void)
{
    if (g_gear.target > 0u) {
        g_gear.target--;
    }
    s_shiftLock = 1u;
}

/* 手动模式直接指定挡位 */
int Shift_Manual(unsigned char gear)
{
    if (gear >= GEAR_COUNT) {
        return -1;
    }
    g_gear.target = gear;
    s_shiftLock = 0u;
    return SET_GEAR(gear);
}

/* 走函数指针表执行（fnptr 边） */
void Shift_ApplyByTable(unsigned char up)
{
    if (up != 0u) {
        INVOKE(&g_gearOps, up);
    } else {
        INVOKE(&g_gearOps, down);
    }
}
