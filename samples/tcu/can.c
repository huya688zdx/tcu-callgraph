#include "can.h"
#include "gear.h"
#include "config.h"

static int Can_SendRaw(unsigned int id, const unsigned char *d, unsigned char len);

void Can_Init(void)
{
    Can_SendRaw(0x100u, 0, 0);
}

unsigned int Can_GetRpm(void)
{
    return 1200u;
}

unsigned int Can_GetSpeed(void)
{
    return 60u;
}

int Can_SendGearStatus(unsigned char gear)
{
    unsigned char buf[2];

    buf[0] = gear;
    buf[1] = 0u;
    return Can_SendRaw(0x201u, buf, 2u);
}

static int Can_SendRaw(unsigned int id, const unsigned char *d, unsigned char len)
{
    CanFrame f;

    f.id  = id;
    f.len = len;
    (void)d;
    return 0;
}

/* 函数指针表：静态初始化，可解析出真实被调函数 */
const ShiftOps g_ops_4at = {
    .shift_up   = Gear_ShiftUp,
    .shift_down = Gear_ShiftDown,
    .apply      = (int (*)(unsigned char, void *))Gear_Apply
};

#ifdef CONFIG_4WD
const ShiftOps g_ops_cvt = {
    .shift_up   = Gear_ShiftUp,
    .shift_down = Gear_ShiftDown,
    .apply      = (int (*)(unsigned char, void *))Gear_Apply
};
#endif
